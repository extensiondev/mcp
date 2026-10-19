import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "../tools/publish";

const SHA = "b418732";
const ZIP = (browser: string) =>
  `npx -y extension@latest preview https://registry.extension.land/cezaraugusto/pii-shield/builds/${SHA}/${browser}.zip?t=share.tok --browser=${browser}`;

type Integrity = { ok: boolean; checks?: unknown[] } | null | "refused";

const platform = vi.hoisted(() => ({
  browsers: [] as Array<{ name: string; status: string }>,
  integrity: {} as Record<string, unknown>,
  detailStatus: 200,
  calls: [] as string[],
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function answer(url: string): Response {
  platform.calls.push(url);

  if (url.endsWith("/api/cli/whoami")) return json({ projectId: "prj_piishield" });

  if (url.endsWith("/api/cli/publish")) {
    return json({
      shareUrl: `https://cezaraugusto.extension.dev/pii-shield/builds/${SHA}?share=share.tok`,
      visibility: "private",
      buildSha: SHA,
      expiresAt: Math.floor(Date.UTC(2026, 9, 26, 12) / 1000),
      previewCommands: Object.fromEntries(platform.browsers.map((b) => [b.name, ZIP(b.name)])),
      token: "share.tok",
    });
  }

  const integrity = /\/api\/projects\/prj_piishield\/builds\/[^/]+\/integrity\/([a-z]+)$/.exec(url);

  if (integrity) {
    const report = platform.integrity[integrity[1]] as Integrity | undefined;
    if (report === "refused") return json({ message: "The registry refused this integrity read." }, 502);

    return new Response(JSON.stringify(report ?? null), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (/\/api\/projects\/prj_piishield\/builds\/[^/]+$/.test(url)) {
    return json({ buildId: SHA, status: "partial", browsers: platform.browsers }, platform.detailStatus);
  }

  throw new Error(`publish-artifact-health cells never reach the network (${url})`);
}

const TRUNCATED = {
  ok: false,
  checks: [{ id: "zip-readable", ok: false, title: "Zip readable", detail: "10476800 of 36211782 bytes, no central directory" }],
};

describe("extension_publish reads the build's artifact health before handing out a link", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevToken: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-publish-health-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevToken = process.env.EXTENSION_DEV_TOKEN;
    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_TOKEN = `${Buffer.from(
      JSON.stringify({ u: "cezaraugusto", p: "pii-shield", exp: Math.floor(Date.now() / 1000) + 600 }),
    ).toString("base64url")}.sig`;

    platform.calls = [];
    platform.detailStatus = 200;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => answer(String(input instanceof Request ? input.url : input))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = prevToken;

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses, without minting a link, a pinned build whose every artifact failed", async () => {
    platform.browsers = [
      { name: "chrome", status: "success" },
      { name: "edge", status: "failed" },
      { name: "firefox", status: "failed" },
    ];

    platform.integrity = { chrome: TRUNCATED, edge: { ok: false, checks: [] }, firefox: { ok: false, checks: [] } };

    const out = JSON.parse(await handler({ buildSha: SHA }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("publish-refused");
    expect(out.error.code).toBe("E_ARTIFACTS_UNVERIFIED");
    expect(out.error.message).toContain("chrome: build success, integrity failed (Zip readable: 10476800 of 36211782 bytes");
    expect(out.error.message).toContain("edge: build failed, integrity failed");
    expect(out.error.message).toContain("firefox: build failed, integrity failed");
    expect(out.hint).toContain("extension_builds (action: 'rebuild', buildId: 'b418732')");
    expect(out.hint).toContain("force: true");
    expect(out.hint).toContain("No link was minted.");
    expect(out.value.artifacts.failed).toEqual(["chrome", "edge", "firefox"]);
    expect(platform.calls.some((url) => url.endsWith("/api/cli/publish"))).toBe(false);
    expect(JSON.stringify(out)).not.toContain("share.tok");
  });

  it("refuses an unpinned publish the same way and withholds the link the platform minted", async () => {
    platform.browsers = [{ name: "chrome", status: "success" }];
    platform.integrity = { chrome: TRUNCATED };

    const out = JSON.parse(await handler({}));

    expect(out.status).toBe("publish-refused");
    expect(out.hint).toContain("Share links section");
    expect(JSON.stringify(out)).not.toContain("share.tok");
  });

  it("publishes a partial build with the failed browser named and left out of the commands", async () => {
    platform.browsers = [
      { name: "chrome", status: "success" },
      { name: "edge", status: "success" },
      { name: "firefox", status: "failed" },
    ];

    platform.integrity = { chrome: { ok: true, checks: [] }, edge: { ok: true, checks: [] }, firefox: TRUNCATED };

    const out = JSON.parse(await handler({ buildSha: SHA }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("published");
    expect(Object.keys(out.value.previewCommands)).toEqual(["chrome", "edge"]);
    expect(out.hint).not.toContain("firefox.zip");
    expect(out.hint).toContain("chrome: ");
    expect(out.value.tellThem).toContain("Use it for Chrome and Edge only: the Firefox download did not pass the platform's checks.");
    expect(out.warnings.join(" ")).toContain("Published, but the platform's checks reject the Firefox artifact");
    expect(out.value.artifacts).toMatchObject({ checked: true, good: ["chrome", "edge"], failed: ["firefox"] });
  });

  it("publishes an all-failed build with force: true and still warns", async () => {
    platform.browsers = [
      { name: "chrome", status: "success" },
      { name: "edge", status: "failed" },
    ];

    platform.integrity = { chrome: TRUNCATED, edge: { ok: false, checks: [] } };

    const out = JSON.parse(await handler({ buildSha: SHA, force: true }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("published");
    expect(out.value.previewCommands).toEqual({});
    expect(out.hint).not.toContain("without opening the share page");
    expect(out.warnings.join(" ")).toContain("Published with force: true although the platform's checks reject the Chrome and Edge artifacts");
    expect(out.value.tellThem).toContain("did not pass the platform's checks for any browser (Chrome and Edge)");
  });

  it("publishes a build with no integrity data and says integrity was not checked", async () => {
    platform.browsers = [
      { name: "chrome", status: "success" },
      { name: "firefox", status: "success" },
    ];

    platform.integrity = {};

    const out = JSON.parse(await handler({ buildSha: SHA }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("published");
    expect(Object.keys(out.value.previewCommands)).toEqual(["chrome", "firefox"]);
    expect(out.warnings.join(" ")).toContain("Integrity was not checked");
    expect(out.value.artifacts.checked).toBe(false);
  });

  it("publishes with a not-checked note when the build record itself cannot be read", async () => {
    platform.browsers = [{ name: "chrome", status: "success" }];
    platform.detailStatus = 404;

    const out = JSON.parse(await handler({ buildSha: SHA }));

    expect(out.ok).toBe(true);
    expect(out.warnings.join(" ")).toContain("Integrity was not checked");
  });

  it("names a browser whose integrity read was refused as not checked rather than failed", async () => {
    platform.browsers = [
      { name: "chrome", status: "success" },
      { name: "firefox", status: "success" },
    ];

    platform.integrity = { chrome: { ok: true, checks: [] }, firefox: "refused" };

    const out = JSON.parse(await handler({ buildSha: SHA }));

    expect(out.status).toBe("published");
    expect(Object.keys(out.value.previewCommands)).toEqual(["chrome", "firefox"]);
    expect(out.warnings.join(" ")).toContain("Integrity was not checked for Firefox");
  });
});
