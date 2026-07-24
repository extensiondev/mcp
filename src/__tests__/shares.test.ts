import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/credentials")>()),
  readValidCredentials: () => null,
}));

import { handler, schema } from "../tools/shares";
import { parseArtifactRef } from "../lib/artifacts-api";
import { recordSharedPreview, sharedPreviewsPath } from "../lib/share-record";

const LOCAL_ID = "gen_00000000000000000000000000000001";
const REMOTE_ID = "gen_00000000000000000000000000000002";
const GONE_ID = "gen_00000000000000000000000000000003";

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

  beforeEach(() => {
    process.env.EXTENSION_DEV_TOKEN = "test-token";
    global.fetch = (async () => {
      throw new Error("no test may reach the real platform");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = origFetch;
    if (origToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = origToken;
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

  it("marks a server share the project never recorded as remoteOnly", async () => {
    const dir = tmpProject();
    seedRecord(dir, LOCAL_ID);
    global.fetch = listingFetch({
      artifacts: [
        { artifactId: LOCAL_ID, live: true, previewUrl: "p1" },
        { artifactId: REMOTE_ID, live: true, previewUrl: "p2" },
      ],
      count: 2,
      matched: 2,
      limit: 100,
      truncated: false,
      scanned: 2,
    });

    const out = JSON.parse(await handler({ projectPath: dir }));
    expect(out.ok).toBe(true);
    const local = out.shares.find((s: any) => s.artifactId === LOCAL_ID);
    const remote = out.shares.find((s: any) => s.artifactId === REMOTE_ID);
    expect(local.recordedLocally).toBe(true);
    expect(local.browser).toBe("chrome");
    expect(remote.recordedLocally).toBe(false);
    expect(remote.remoteOnly).toContain("another machine");
    expect(out.localOnly).toEqual([]);
  });

  it("calls a past-its-expiry local record expired when the list is whole", async () => {
    const dir = tmpProject();
    seedRecord(dir, GONE_ID, "2026-01-01T00:00:00.000Z");
    global.fetch = listingFetch({
      artifacts: [],
      count: 0,
      matched: 0,
      limit: 100,
      truncated: false,
      scanned: 4,
    });

    const out = JSON.parse(await handler({ projectPath: dir }));
    expect(out.localOnly).toHaveLength(1);
    expect(out.localOnly[0].artifactId).toBe(GONE_ID);
    expect(out.localOnly[0].status).toContain("expired");
    expect(out.server.truncated).toBe(false);
  });

  it("refuses to call a local record dead when the server list was cut", async () => {
    const dir = tmpProject();
    seedRecord(dir, GONE_ID, "2026-01-01T00:00:00.000Z");
    global.fetch = listingFetch({
      artifacts: [],
      count: 0,
      matched: 40,
      limit: 100,
      truncated: true,
      scanned: 200,
    });

    const out = JSON.parse(await handler({ projectPath: dir }));
    expect(out.server.truncated).toBe(true);
    expect(out.server.truncatedNote).toContain("not the whole set");
    expect(out.localOnly[0].status).toContain("unknown");
  });

  it("degrades to the local record plus a login hint with no token", async () => {
    delete process.env.EXTENSION_DEV_TOKEN;
    const dir = tmpProject();
    seedRecord(dir, LOCAL_ID);

    const out = JSON.parse(await handler({ projectPath: dir }));
    expect(out.ok).toBe(true);
    expect(out.server.listed).toBe(false);
    expect(out.server.loginHint).toContain("extension_login");
    expect(out.localOnly).toHaveLength(1);
    expect(out.localOnly[0].revokeUrl).toContain(LOCAL_ID);
  });

  it("revokes by url and leaves the append-only record untouched", async () => {
    const dir = tmpProject();
    seedRecord(dir, LOCAL_ID);
    const before = fs.readFileSync(sharedPreviewsPath(dir), "utf8");
    global.fetch = listingFetch({
      artifactId: LOCAL_ID,
      revoked: true,
      revokedAt: "2026-07-24T12:00:00.000Z",
    });

    const out = JSON.parse(
      await handler({
        action: "revoke",
        url: `https://preview.extension.dev/?preview=${LOCAL_ID}`,
        projectPath: dir,
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.artifactId).toBe(LOCAL_ID);
    expect(out.revoked).toBe(true);
    expect(out.note).toContain("permanently");
    expect(out.recordNote).toContain("not rewritten");
    expect(fs.readFileSync(sharedPreviewsPath(dir), "utf8")).toBe(before);
  });

  it("asks for an id instead of guessing when nothing resolves", async () => {
    const out = JSON.parse(
      await handler({ action: "revoke", url: "https://example.com/nope" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("SharesInputError");
  });

  it("reports a 404 revoke as a share this token does not own", async () => {
    global.fetch = listingFetch({ message: "Artifact not found." }, 404);
    const out = JSON.parse(
      await handler({ action: "revoke", artifactId: REMOTE_ID }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("SharesNotFoundError");
    expect(out.error.message).toContain("different project");
  });
});
