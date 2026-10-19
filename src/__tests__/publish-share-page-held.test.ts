import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "../tools/publish";

const SHARE = "https://cezaraugusto.extension.dev/pii-shield/builds/b4187328?share=share.tok";
const CHROME =
  "npx -y extension@latest preview https://registry.extension.land/cezaraugusto/pii-shield/builds/b4187328/chrome.zip?t=share.tok --browser=chrome";
const FIREFOX =
  "npx -y extension@latest preview https://registry.extension.land/cezaraugusto/pii-shield/builds/b4187328/firefox.zip?t=share.tok --browser=firefox";

type PageAnswer = { status: number; headers?: Record<string, string> };

let page: PageAnswer;
let pageProbes: string[];

function production(url: string, init?: RequestInit): Response {
  if (url.endsWith("/api/cli/publish")) {
    return new Response(
      JSON.stringify({
        shareUrl: SHARE,
        visibility: "private",
        buildSha: "b4187328",
        expiresAt: "2026-10-26T17:27:00.000Z",
        previewCommands: { chrome: CHROME, firefox: FIREFOX },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  if (url === SHARE) {
    pageProbes.push(String(init?.method ?? "GET"));

    return new Response(null, { status: page.status, headers: page.headers });
  }

  return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
}

describe("extension_publish while the platform holds the public", () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-publish-held-"));

    for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_API_URL"]) saved[key] = process.env[key];

    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_API_URL = "https://www.extension.dev";
    process.env.EXTENSION_DEV_TOKEN = `${Buffer.from(JSON.stringify({ u: "cezaraugusto", p: "pii-shield", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
    pageProbes = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
        production(String(input instanceof Request ? input.url : input), init),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("answers platform-held and never promises a share page that serves the 503 hold page", async () => {
    page = { status: 503, headers: { "retry-after": "86400" } };

    const out = JSON.parse(await handler({ buildSha: "b4187328" }));

    expect(pageProbes).toEqual(["HEAD"]);
    expect(out.ok).toBe(true);
    expect(out.status).toBe("platform-held");
    expect(out.value.sharePage).toEqual({ url: SHARE, status: 503, retryAfter: "86400", opensNow: false });
    expect(out.value.tellThem).not.toMatch(/Anyone who has it can open it/);
    expect(out.value.tellThem).toContain("not open yet");
    expect(out.value.tellThem).toContain(`chrome: ${CHROME}`);
    expect(out.value.tellThem).toContain("registry.extension.land");
    expect(out.value.previewCommands).toEqual({ chrome: CHROME, firefox: FIREFOX });
    expect(out.hint).not.toContain(`Send ${SHARE}`);
    expect(out.warnings.join(" ")).toContain("What works now: the run commands in value.previewCommands");
    expect(out.warnings.join(" ")).toContain("What does not: the share page, until the platform opens");
  });

  it("reads a retry-after hold answer that is not a 503 as held too", async () => {
    page = { status: 429, headers: { "retry-after": "3600" } };

    const out = JSON.parse(await handler({}));

    expect(out.status).toBe("platform-held");
  });

  it("falls back to GET when the page refuses HEAD", async () => {
    page = { status: 405 };

    const out = JSON.parse(await handler({}));

    expect(pageProbes).toEqual(["HEAD", "GET"]);
    expect(out.status).toBe("published");
  });

  it("keeps published and the build link sentence when the share page opens", async () => {
    page = { status: 200 };

    const out = JSON.parse(await handler({}));

    expect(out.status).toBe("published");
    expect(out.value.sharePage).toBeUndefined();
    expect(out.value.tellThem).toMatch(/Anyone who has it can open it until/);
    expect(out.hint).toContain(`Send ${SHARE}`);
  });
});
