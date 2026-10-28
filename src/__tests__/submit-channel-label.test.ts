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

import { handler, schema } from "../tools/submit";

const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_APPROVAL_GATE"];
const saved: Record<string, string | undefined> = {};
let tmp: string;
let prevFetch: typeof fetch;
let urls: string[];
let bodies: Array<Record<string, unknown>>;
let platformAnswer: Record<string, unknown>;

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
  bodies = [];
  platformAnswer = { ok: true, dryRun: true };
  prevFetch = global.fetch;
  global.fetch = (async (url: string, init?: { body?: string }) => {
    const target = String(url);
    urls.push(target);
    if (init?.body) bodies.push(JSON.parse(init.body) as Record<string, unknown>);

    const body = target.includes("/api/cli/stores/submit")
      ? platformAnswer
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

describe("a submission carries no channel label: the channel is the one that pins the build, read by the platform", () => {
  it("takes no channel input and sends none to the platform", async () => {
    expect(Object.keys(schema.inputSchema.properties)).not.toContain("channel");

    const out = JSON.parse(await handler({ browsers: ["chrome"], buildSha: "e4b8976" }));

    expect(out.ok).toBe(true);
    expect(bodies.find((body) => "browsers" in body)).toEqual({ browsers: ["chrome"], buildSha: "e4b8976", dryRun: true });
    expect(urls.some((url) => url.includes("channels.json"))).toBe(false);
  });

  it("never warns about a defaulted channel or a release channel it did not read", async () => {
    const out = JSON.parse(await handler({ browsers: ["chrome"], buildSha: "e4b8976" }));
    const said = out.warnings.join(" ");

    expect(said).not.toContain("channel:");
    expect(said).not.toContain("release channels");
    expect(out.value.channel).toBeUndefined();
    expect(out.value.channelDefaulted).toBeUndefined();
  });

  it("answers the channel the platform found the build promoted to, and only that", async () => {
    platformAnswer = { ok: true, dryRun: true, channel: "preview" };

    const out = JSON.parse(await handler({ browsers: ["chrome"], buildSha: "1111111" }));

    expect(out.value.channel).toBe("preview");
  });
});
