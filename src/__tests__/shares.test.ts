import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler, schema } from "../tools/shares";
import * as sharesTool from "../tools/shares";
import { forwardable } from "../lib/hosted-forwarder";
import { parseArtifactRef } from "../lib/artifacts-api";
import { recordSharedPreview, sharedPreviewsPath } from "../lib/share-record";

import type { ToolModule } from "../lib/tool-dispatch";

const LOCAL_ID = "gen_00000000000000000000000000000001";
const REMOTE_ID = "gen_00000000000000000000000000000002";
const GONE_ID = "gen_00000000000000000000000000000003";
const FULL_ID = `gen_${"0123456789abcdef".repeat(4)}`;

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shares-tool-"));
}

function seedRecord(dir: string, artifactId: string, expiresAt?: string) {
  recordSharedPreview(dir, {
    sharedAt: "2026-07-20T10:00:00.000Z",
    previewUrl: `https://preview.extension.dev/?preview=${artifactId}`,
    artifactId,
    revokeUrl: `https://www.extension.dev/api/artifacts/${artifactId}`,
    browser: "chrome",
    distDir: path.join(dir, "dist", "chrome"),
    ...(expiresAt ? { expiresAt } : {}),
  });
}

function listingFetch(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe("extension_shares", () => {
  const origFetch = global.fetch;
  const origToken = process.env.EXTENSION_DEV_TOKEN;
  const origGate = process.env.EXTENSION_DEV_APPROVAL_GATE;
  const origXdg = process.env.XDG_CONFIG_HOME;
  const origAppData = process.env.APPDATA;
  let emptyConfig = "";

  beforeEach(() => {
    process.env.EXTENSION_DEV_TOKEN = "test-token";
    emptyConfig = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shares-config-"));
    process.env.XDG_CONFIG_HOME = emptyConfig;
    process.env.APPDATA = emptyConfig;
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    global.fetch = (async () => {
      throw new Error("no test may reach the real platform");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = origFetch;
    if (origToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = origToken;
    if (origGate === undefined) delete process.env.EXTENSION_DEV_APPROVAL_GATE;
    else process.env.EXTENSION_DEV_APPROVAL_GATE = origGate;

    fs.rmSync(emptyConfig, { recursive: true, force: true });
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
    if (origAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = origAppData;
  });

  it("names the tool and defaults to listing", () => {
    expect(schema.name).toBe("extension_shares");
    expect(schema.inputSchema.required).toEqual([]);
    expect(
      (schema.inputSchema.properties as any).action.default,
    ).toBe("list");
  });

  it("reads an artifact id out of every url the platform hands back", () => {
    expect(parseArtifactRef(LOCAL_ID)).toBe(LOCAL_ID);
    expect(
      parseArtifactRef(`https://preview.extension.dev/?preview=${LOCAL_ID}`),
    ).toBe(LOCAL_ID);

    expect(
      parseArtifactRef(`https://www.extension.dev/api/artifacts/${LOCAL_ID}`),
    ).toBe(LOCAL_ID);

    expect(
      parseArtifactRef(
        `https://www.extension.dev/api/artifacts/${LOCAL_ID}/source.zip`,
      ),
    ).toBe(LOCAL_ID);

    expect(parseArtifactRef(`https://templates.extension.dev/a/${LOCAL_ID}`)).toBe(
      LOCAL_ID,
    );

    expect(parseArtifactRef("not-a-share")).toBeNull();
    expect(parseArtifactRef("")).toBeNull();
  });

  it("round-trips a full 64-hex id unmangled, bare and inside every url", () => {
    expect(FULL_ID).toHaveLength(68);
    expect(parseArtifactRef(FULL_ID)).toBe(FULL_ID);
    expect(
      parseArtifactRef(`https://preview.extension.dev/?preview=${FULL_ID}`),
    ).toBe(FULL_ID);

    expect(
      parseArtifactRef(`https://www.extension.dev/api/artifacts/${FULL_ID}`),
    ).toBe(FULL_ID);

    expect(
      parseArtifactRef(
        `https://www.extension.dev/api/artifacts/${FULL_ID}/source.zip`,
      ),
    ).toBe(FULL_ID);

    expect(parseArtifactRef(`revoke ${FULL_ID} please`)).toBe(FULL_ID);
  });

  it("refuses a width the mint never issued instead of taking a substring", () => {
    const hex63 = FULL_ID.slice(0, -1);
    const hex65 = `${FULL_ID}0`;
    const hex40 = `gen_${"a".repeat(40)}`;
    expect(parseArtifactRef(hex63)).toBeNull();
    expect(parseArtifactRef(hex65)).toBeNull();
    expect(parseArtifactRef(hex40)).toBeNull();
    expect(
      parseArtifactRef(`https://preview.extension.dev/?preview=${hex65}`),
    ).toBeNull();
  });

  it("776: a signed-out list for a project folder answers the folder's own share record beside the login hint, and nothing is sent", async () => {
    delete process.env.EXTENSION_DEV_TOKEN;
    const dir = tmpProject();
    const reshared = "2026-08-03T10:00:00.000Z";

    seedRecord(dir, LOCAL_ID);
    recordSharedPreview(dir, { sharedAt: reshared, previewUrl: `https://preview.extension.dev/?preview=${LOCAL_ID}`, artifactId: LOCAL_ID, revokeUrl: `https://extension.dev/api/artifacts/${LOCAL_ID}` });
    seedRecord(dir, GONE_ID);

    const forwarded = forwardable(sharesTool as unknown as ToolModule).handler as (args: Record<string, unknown>) => Promise<string>;
    const out = JSON.parse(await forwarded({ projectPath: dir }));

    expect(out).toMatchObject({ ok: true, command: "extension_shares", status: "listed-local-only" });
    expect(out.value.platform).toMatchObject({ listed: false, errorName: "SharesAuthError" });
    expect(out.value.platform.loginHint).toContain("extension_auth");
    expect(out.value.server).toBeUndefined();
    expect(out.value.shares).toEqual([]);
    expect(out.value.localOnly.map((row: { artifactId: string; sharedAt: string; revokeUrl: string }) => [row.artifactId, row.sharedAt, row.revokeUrl])).toEqual([
      [LOCAL_ID, reshared, `https://www.extension.dev/api/artifacts/${LOCAL_ID}`],
      [GONE_ID, "2026-07-20T10:00:00.000Z", `https://www.extension.dev/api/artifacts/${GONE_ID}`],
    ]);

    expect(out.value.localRecord).toMatchObject({ path: sharedPreviewsPath(dir), exists: true, entries: 3, shares: 2 });
    expect(out.warnings.join(" ")).toContain("The platform was not asked");

    const bare = JSON.parse(await forwarded({ action: "list" }));
    const revoke = JSON.parse(await forwarded({ action: "revoke", artifactId: LOCAL_ID, projectPath: dir }));

    expect([bare.status, revoke.status]).toEqual(["auth-required", "auth-required"]);
  });
});
