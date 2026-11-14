// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pageShaShortened } from "../lib/publish-link";
import { handler } from "../tools/publish";

const FULL = "F25F2B53548B6510836DE8FA675094F92E33F5FB";
const SHORT = "f25f2b5";
const LONG_PAGE = `https://cezaraugusto.extension.dev/leon/builds/${FULL}?share=nIxs8xJwBXw`;
const SHORT_PAGE = `https://cezaraugusto.extension.dev/leon/builds/${SHORT}?share=nIxs8xJwBXw`;
const RUN = (browser: string) =>
  `npx -y extension@latest preview https://cezaraugusto.extension.dev/leon/builds/${SHORT}/${browser}.zip?share=nIxs8xJwBXw --browser=${browser}`;

let page: { status: number; headers?: Record<string, string> };
let probed: string[];
let exchanged: string[];
let record: { status: number; body?: unknown };

function platformAnswer(): Record<string, unknown> {
  return {
    shareUrl: LONG_PAGE,
    projectName: "Leon",
    visibility: "private",
    buildSha: FULL,
    expiresAt: "2026-11-13T00:58:00.000Z",
    link: { kind: "build", url: LONG_PAGE, id: "nIxs8xJwBXw", expiresAt: "2026-11-13T00:58:00.000Z", pointsAt: "this build", audience: "anyone with the link" },
    previewCommands: { chrome: RUN("chrome"), firefox: RUN("firefox") },
  };
}

function production(url: string, init?: RequestInit): Response {
  if (url.endsWith("/api/cli/publish")) {
    return new Response(JSON.stringify(platformAnswer()), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (url.startsWith("https://cezaraugusto.extension.dev/leon/builds/")) {
    probed.push(`${String(init?.method ?? "GET")} ${url}`);

    return new Response(null, { status: page.status, headers: page.headers });
  }

  if (url.includes("/api/public/share/nIxs8xJwBXw?")) {
    exchanged.push(url);

    return new Response(JSON.stringify(record.body ?? { message: "not found" }), { status: record.status, headers: { "content-type": "application/json" } });
  }

  return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
}

describe("extension_publish names the build the way the page does and says whether the page opens (ledger 435)", () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-publish-sha-"));

    for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_API_URL"]) saved[key] = process.env[key];

    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_API_URL = "https://www.extension.dev";
    process.env.EXTENSION_DEV_TOKEN = `${Buffer.from(JSON.stringify({ u: "cezaraugusto", p: "leon", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
    probed = [];
    exchanged = [];
    page = { status: 200 };
    record = { status: 200, body: { token: "never-answered", expiresAt: 1794445080, scope: `build:${SHORT}` } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => production(String(input instanceof Request ? input.url : input), init)),
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

  it("shortens only a forty character page sha and leaves every other address alone", () => {
    expect(pageShaShortened(LONG_PAGE)).toBe(SHORT_PAGE);
    expect(pageShaShortened(SHORT_PAGE)).toBe(SHORT_PAGE);
    expect(pageShaShortened(`https://cezaraugusto.extension.dev/leon/builds/${FULL}`)).toBe(`https://cezaraugusto.extension.dev/leon/builds/${SHORT}`);
    expect(pageShaShortened(`https://cezaraugusto.extension.dev/leon/builds/${FULL}/chrome.zip?share=x`)).toBe(`https://cezaraugusto.extension.dev/leon/builds/${SHORT}/chrome.zip?share=x`);
    expect(pageShaShortened("https://cezaraugusto.extension.dev/leon/builds/f25f2b53548b6510836de8fa675094f92e33f5fbaa")).toBe(
      "https://cezaraugusto.extension.dev/leon/builds/f25f2b53548b6510836de8fa675094f92e33f5fbaa",
    );

    expect(pageShaShortened("https://cezaraugusto.extension.dev/leon/channels/stable?share=x")).toBe("https://cezaraugusto.extension.dev/leon/channels/stable?share=x");
  });
});
