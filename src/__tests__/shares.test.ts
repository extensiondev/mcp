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
    const local = out.value.shares.find((s: any) => s.artifactId === LOCAL_ID);
    const remote = out.value.shares.find((s: any) => s.artifactId === REMOTE_ID);
    expect(local.recordedLocally).toBe(true);
    expect(local.browser).toBe("chrome");
    expect(remote.recordedLocally).toBe(false);
    expect(remote.remoteOnly).toContain("another machine");
    expect(out.value.localOnly).toEqual([]);
  });

  it("carries owner and sharedBy through and credits a resolved login", async () => {
    global.fetch = listingFetch({
      artifacts: [
        {
          artifactId: LOCAL_ID,
          live: true,
          owner: { kind: "project", workspace: "acme", project: "tab-sorter" },
          sharedBy: {
            via: "token",
            login: "ada",
            workspace: "acme",
            project: "tab-sorter",
            tokenId: "tok_9f3",
          },
        },
      ],
      count: 1,
      matched: 1,
      limit: 100,
      truncated: false,
      scanned: 1,
    });

    const out = JSON.parse(await handler({}));
    const share = out.value.shares[0];
    expect(share.owner).toEqual({
      kind: "project",
      workspace: "acme",
      project: "tab-sorter",
    });
    expect(share.sharedBy.tokenId).toBe("tok_9f3");
    expect(share.attribution).toEqual({
      ownership: "project",
      ownerPath: "acme/tab-sorter",
      credit: "ada",
      creditSource: "login",
      revocableBy: expect.stringContaining("Any member of the owning workspace"),
    });
    expect(out.value.server.ownership).toEqual({
      project: 1,
      personal: 0,
      unknown: 0,
    });
  });

  it("names the token instead of a person when the issuer is unresolved", async () => {
    global.fetch = listingFetch({
      artifacts: [
        {
          artifactId: LOCAL_ID,
          live: true,
          owner: { kind: "project", workspace: "acme", project: "tab-sorter" },
          sharedBy: {
            via: "token",
            login: null,
            workspace: "acme",
            project: "tab-sorter",
            tokenId: "tok_9f3",
          },
        },
      ],
      count: 1,
      matched: 1,
      limit: 100,
      truncated: false,
      scanned: 1,
    });

    const out = JSON.parse(await handler({}));
    expect(out.value.shares[0].attribution.credit).toBe("CLI token tok_9f3");
    expect(out.value.shares[0].attribution.creditSource).toBe("tokenId");
  });

  it("says a personal share cannot be revoked by this project token", async () => {
    global.fetch = listingFetch({
      artifacts: [
        {
          artifactId: LOCAL_ID,
          live: true,
          owner: { kind: "user" },
          sharedBy: {
            via: "session",
            login: "ada",
            workspace: null,
            project: null,
            tokenId: null,
          },
        },
      ],
      count: 1,
      matched: 1,
      limit: 100,
      truncated: false,
      scanned: 1,
    });

    const out = JSON.parse(await handler({}));
    expect(out.value.shares[0].attribution.ownership).toBe("personal");
    expect(out.value.shares[0].attribution.ownerPath).toBeUndefined();
    expect(out.value.shares[0].attribution.revocableBy).toContain(
      "cannot pull it back",
    );
    expect(out.value.server.ownership.personal).toBe(1);
  });

  it("reports a legacy share with no attribution as an explicit unknown", async () => {
    global.fetch = listingFetch({
      artifacts: [{ artifactId: LOCAL_ID, live: true }],
      count: 1,
      matched: 1,
      limit: 100,
      truncated: false,
      scanned: 1,
    });

    const out = JSON.parse(await handler({}));
    expect(out.value.shares[0].owner).toBeNull();
    expect(out.value.shares[0].sharedBy).toBeNull();
    expect(out.value.shares[0].attribution.ownership).toBe("unknown");
    expect(out.value.shares[0].attribution.creditSource).toBe("none");
    expect(out.value.shares[0].attribution.credit).toContain(
      "predates publisher attribution",
    );
    expect(out.value.server.ownership.unknown).toBe(1);
  });

  it("never turns a workspace, a project or an owner into a publisher", async () => {
    global.fetch = listingFetch({
      artifacts: [
        {
          artifactId: LOCAL_ID,
          live: true,
          owner: { kind: "project", workspace: "acme", project: "tab-sorter" },
          sharedBy: {
            via: "token",
            login: null,
            workspace: "acme",
            project: "tab-sorter",
            tokenId: null,
          },
        },
        {
          artifactId: REMOTE_ID,
          live: true,
          owner: { kind: "project", workspace: "acme", project: "tab-sorter" },
          sharedBy: null,
        },
      ],
      count: 2,
      matched: 2,
      limit: 100,
      truncated: false,
      scanned: 2,
    });

    const out = JSON.parse(await handler({}));
    for (const share of out.value.shares) {
      expect(share.attribution.creditSource).toBe("none");
      expect(share.attribution.credit).not.toContain("acme");
      expect(share.attribution.credit).not.toContain("tab-sorter");
    }
    expect(out.value.shares[0].attribution.credit).toContain("could not resolve");
    expect(out.value.shares[1].attribution.credit).toContain("predates");
  });

  it("explains the personal-vs-project split alongside the rows", async () => {
    global.fetch = listingFetch({
      artifacts: [{ artifactId: LOCAL_ID, live: true, owner: { kind: "user" } }],
      count: 1,
      matched: 1,
      limit: 100,
      truncated: false,
      scanned: 1,
    });

    const out = JSON.parse(await handler({}));
    const attributionNote = out.warnings.find((w: string) =>
      w.includes("attribution.ownership"),
    );
    expect(attributionNote).toContain("attribution only");
    expect(attributionNote).toContain("any member can pull it back");
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
    expect(out.value.localOnly).toHaveLength(1);
    expect(out.value.localOnly[0].artifactId).toBe(GONE_ID);
    expect(out.value.localOnly[0].status).toContain("expired");
    expect(out.value.server.truncated).toBe(false);
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
    expect(out.value.server.truncated).toBe(true);
    expect(out.value.server.truncatedNote).toContain("not the whole set");
    expect(out.value.server.truncatedNote).toContain("matched is a floor");
    expect(
      out.warnings.some((w: string) => w.includes("not the whole set")),
    ).toBe(true);
    expect(out.value.localOnly[0].status).toContain("unknown");
  });

  it("degrades to the local record plus a login hint with no token", async () => {
    delete process.env.EXTENSION_DEV_TOKEN;
    const dir = tmpProject();
    seedRecord(dir, LOCAL_ID);

    const out = JSON.parse(await handler({ projectPath: dir }));
    expect(out.ok).toBe(true);
    expect(out.status).toBe("listed-local-only");
    expect(out.value.server.listed).toBe(false);
    expect(out.value.server.loginHint).toContain("extension_auth");
    expect(out.value.localOnly).toHaveLength(1);
    expect(out.value.localOnly[0].revokeUrl).toContain(LOCAL_ID);
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
    expect(out.status).toBe("revoked");
    expect(out.value.artifactId).toBe(LOCAL_ID);
    expect(out.value.revoked).toBe(true);
    expect(
      out.warnings.some((w: string) => w.includes("permanently")),
    ).toBe(true);
    expect(
      out.warnings.some((w: string) => w.includes("not rewritten")),
    ).toBe(true);
    expect(fs.readFileSync(sharedPreviewsPath(dir), "utf8")).toBe(before);
  });

  it("asks for an id instead of guessing when nothing resolves", async () => {
    const out = JSON.parse(
      await handler({ action: "revoke", url: "https://example.com/nope" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.name).toBe("SharesInputError");
  });

  it("reports a 404 revoke as a share this token does not own", async () => {
    global.fetch = listingFetch({ message: "Artifact not found." }, 404);
    const out = JSON.parse(
      await handler({ action: "revoke", artifactId: REMOTE_ID }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("revoke-failed");
    expect(out.error.code).toBe("E_PLATFORM");
    expect(out.error.name).toBe("SharesNotFoundError");
    expect(out.error.message).toContain("different project");
  });
});
