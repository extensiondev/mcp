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

const LONG_TOKEN = `eyJ${"a".repeat(400)}`;
const LONG_SHARE = `https://cezaraugusto.extension.dev/pii-shield/builds/b4187328?share=${LONG_TOKEN}`;
const LONG_ZIP = (browser: string) =>
  `https://registry.extension.land/cezaraugusto/pii-shield/builds/b4187328/${browser}.zip?t=${LONG_TOKEN}`;
const SHORT_PAGE = "https://cezaraugusto.extension.dev/pii-shield/builds/b4187328?share=k3x9q";
const SHORT_ZIP = (browser: string) => `https://cezaraugusto.extension.dev/pii-shield/builds/b4187328/${browser}.zip?share=k3x9q`;
const SHORT_RUN = (browser: string) => `npx -y extension@latest preview ${SHORT_ZIP(browser)} --browser=${browser}`;

type PageAnswer = { status: number; headers?: Record<string, string> };

let page: PageAnswer;
let pageProbes: string[];
let answer: Record<string, unknown>;

function oldAnswer(): Record<string, unknown> {
  return {
    shareUrl: SHARE,
    visibility: "private",
    buildSha: "b4187328",
    expiresAt: "2026-10-26T17:27:00.000Z",
    previewCommands: { chrome: CHROME, firefox: FIREFOX },
  };
}

function shortAnswer(): Record<string, unknown> {
  return {
    shareUrl: SHORT_PAGE,
    projectName: "PII Shield",
    visibility: "private",
    buildSha: "b4187328",
    expiresAt: "2026-10-26T17:27:00.000Z",
    token: LONG_TOKEN,
    link: {
      kind: "build",
      url: SHORT_PAGE,
      id: "k3x9q",
      expiresAt: "2026-10-26T17:27:00.000Z",
      pointsAt: "this build",
      audience: "anyone with the link",
    },
    previewCommands: { chrome: SHORT_RUN("chrome"), firefox: SHORT_RUN("firefox"), edge: SHORT_RUN("edge") },
  };
}

function longAnswer(): Record<string, unknown> {
  return {
    shareUrl: LONG_SHARE,
    projectName: "PII Shield",
    visibility: "private",
    buildSha: "b4187328",
    expiresAt: "2026-10-26T17:27:00.000Z",
    previewCommands: Object.fromEntries(
      ["chrome", "firefox", "edge"].map((browser) => [browser, `npx -y extension@latest preview ${LONG_ZIP(browser)} --browser=${browser}`]),
    ),
  };
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
}

function production(url: string, init?: RequestInit): Response {
  if (url.endsWith("/api/cli/publish")) {
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (url === String(answer.shareUrl)) {
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
    answer = oldAnswer();
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
    expect(out.value.tellThem).not.toContain(SHARE);
    expect(out.value.tellThem).toContain(`run \`npx -y extension@latest preview "${CHROME.split(" ")[4]}" --browser=chrome\``);
    expect(out.value.tellThem).not.toContain("firefox.zip");
    expect(out.value.tellThem).toContain("Ask me for Firefox.");
    expect(out.value.previewCommands).toEqual({ chrome: CHROME, firefox: FIREFOX });
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

  it("keeps published and the page sentence when the share page opens", async () => {
    page = { status: 200 };

    const out = JSON.parse(await handler({}));

    expect(out.status).toBe("published");
    expect(out.value.sharePage).toBeUndefined();
    expect(out.value.tellThem).toBe(`Here is pii-shield to try: ${SHARE}. It works until October 26, 2026 at 17:27 UTC.`);
  });

  describe("the short link the platform mints", () => {
    beforeEach(() => {
      answer = shortAnswer();
    });

    it("says the page in one line with no share token and no registry host", async () => {
      page = { status: 200 };

      const out = JSON.parse(await handler({}));

      expect(out.status).toBe("published");
      expect(out.value.tellThem).toBe(`Here is PII Shield to try: ${SHORT_PAGE}. It works until October 26, 2026 at 17:27 UTC.`);
      expect(out.value.tellThem).not.toContain("eyJ");
      expect(out.value.tellThem).not.toContain("registry.extension.land");
      expect(out.value.link).toMatchObject({ kind: "build", url: SHORT_PAGE, id: "k3x9q" });
      expect(out.value.trackUrl).toBe("https://console.extension.dev/cezaraugusto/pii-shield/project-settings/share-links");
      expect(JSON.stringify(out.value)).not.toContain(LONG_TOKEN);
    });

    it("adds the short Chrome run command on a second line while the page is held", async () => {
      page = { status: 503, headers: { "retry-after": "86400" } };

      const out = JSON.parse(await handler({}));

      expect(out.status).toBe("platform-held");
      expect(out.value.tellThem).toBe(
        [
          `Here is PII Shield to try: ${SHORT_PAGE}. It works until October 26, 2026 at 17:27 UTC.`,
          `The page opens once extension.dev opens; until then run \`npx -y extension@latest preview "${SHORT_ZIP("chrome")}" --browser=chrome\` (Firefox and Edge: swap the browser name twice).`,
        ].join("\n"),
      );

      expect(out.value.tellThem.split("\n").length).toBeLessThanOrEqual(3);
      expect(out.value.tellThem).not.toContain("eyJ");
      expect(out.value.tellThem).not.toContain("registry.extension.land");
      expect(out.value.link.id).toBe("k3x9q");
    });

    it("gives the agent a hint of two sentences: what to send and where to watch", async () => {
      page = { status: 503, headers: { "retry-after": "86400" } };

      const out = JSON.parse(await handler({}));

      expect(sentences(out.hint)).toHaveLength(2);
      expect(out.hint).toContain(out.value.trackUrl);
      expect(out.hint).not.toContain("eyJ");
      expect(out.value.notes.length).toBeGreaterThan(0);
    });
  });

  describe("an older platform that still answers long registry links", () => {
    beforeEach(() => {
      answer = longAnswer();
    });

    it("keeps the commands, shows only Chrome in tellThem and says why the link is long", async () => {
      page = { status: 503, headers: { "retry-after": "86400" } };

      const out = JSON.parse(await handler({}));

      expect(out.status).toBe("platform-held");
      expect(Object.keys(out.value.previewCommands)).toEqual(["chrome", "firefox", "edge"]);
      expect(out.value.tellThem).toBe(
        `Here is PII Shield to try: run \`npx -y extension@latest preview "${LONG_ZIP("chrome")}" --browser=chrome\`. It works until October 26, 2026 at 17:27 UTC.\nAsk me for Firefox or Edge.`,
      );

      expect(out.value.tellThem).not.toContain("firefox.zip");
      expect(out.value.link.id).toBeNull();
      expect(sentences(out.hint)).toHaveLength(2);
      expect(out.hint).toContain("the platform has not minted a short");
      expect(out.value.trackUrl).toContain("/project-settings/share-links");
    });
  });
});
