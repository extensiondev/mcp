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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler } from "../tools/submit";

const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_APPROVAL_GATE"];
const saved: Record<string, string | undefined> = {};
let tmp: string;
let prevFetch: typeof fetch;
let urls: string[];

function claimsToken(u: string, p: string): string {
  return `${Buffer.from(JSON.stringify({ u, p, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-submit-channel-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
  process.env.EXTENSION_DEV_TOKEN = claimsToken("cezaraugusto", "rebeccat");
  urls = [];
  prevFetch = global.fetch;
  global.fetch = (async (url: string) => {
    const target = String(url);
    urls.push(target);
    const body = target.includes("/api/cli/stores/submit")
      ? { ok: true, dryRun: true }
      : target.includes("channels.json")
        ? { "chrome-preview": { buildId: "1111111" } }
        : {};

    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = prevFetch;

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ledger 254, also: a dry run never claims a submission needs a promoted build in its channel", () => {
  it("says nothing about the default channel, which only labels the records of the build named", async () => {
    const out = JSON.parse(await handler({ browsers: ["chrome"], buildSha: "e4b8976" }));

    expect(out.warnings.join(" ")).not.toContain("does not exist");
    expect(out.warnings.join(" ")).not.toContain("release channels");
    expect(out.warnings.join(" ")).not.toContain("promoted build");
    expect(urls.some((url) => url.includes("channels.json"))).toBe(false);
  });

  it("names a missing channel passed by hand as a label, and says the build named is still the one sent", async () => {
    const out = JSON.parse(await handler({ browsers: ["chrome"], buildSha: "e4b8976", channel: "beta" }));
    const said = out.warnings.join(" ");

    expect(said).toContain('Channel "beta" is not one of this project\'s release channels (existing: chrome-preview)');
    expect(said).toContain("The submission still sends build e4b8976 as named");
    expect(said).not.toContain("promoted build");
  });
});
