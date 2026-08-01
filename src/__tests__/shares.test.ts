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

  it("sends the whole 64-hex id to the platform when revoking", async () => {
    let requested = "";
    global.fetch = (async (url: unknown) => {
      requested = String(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ artifactId: FULL_ID, revoked: true }),
      };
    }) as unknown as typeof fetch;

    const out = JSON.parse(
      await handler({
        action: "revoke",
        url: `https://preview.extension.dev/?preview=${FULL_ID}`,
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.status).toBe("revoked");
    expect(out.value.artifactId).toBe(FULL_ID);
    expect(requested).toContain(`/api/artifacts/${FULL_ID}`);
  });

  it("calls a malformed ref malformed instead of guessing at causes", async () => {
    const out = JSON.parse(
      await handler({ action: "revoke", artifactId: FULL_ID.slice(0, -1) }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.name).toBe("SharesInputError");
    expect(out.error.message).toContain("malformed");
    expect(out.error.message).toContain("64");
    expect(out.error.message).not.toContain("already revoked");
    expect(out.error.message).not.toContain("different project");
  });

  it("hands out the www revoke handle even when the platform sends the apex", async () => {
    global.fetch = listingFetch({
      artifacts: [
        {
          artifactId: FULL_ID,
          live: true,
          revokeUrl: `https://extension.dev/api/artifacts/${FULL_ID}`,
        },
      ],
      count: 1,
      matched: 1,
      limit: 100,
      truncated: false,
      scanned: 1,
    });

    const out = JSON.parse(await handler({}));
    expect(out.value.shares[0].revokeUrl).toBe(
      `https://www.extension.dev/api/artifacts/${FULL_ID}`,
    );
  });

  it("rewrites an apex revoke handle in the local record to the www host", async () => {
    delete process.env.EXTENSION_DEV_TOKEN;
    const dir = tmpProject();
    recordSharedPreview(dir, {
      sharedAt: "2026-07-20T10:00:00.000Z",
      previewUrl: `https://preview.extension.dev/?preview=${FULL_ID}`,
      artifactId: FULL_ID,
      revokeUrl: `https://extension.dev/api/artifacts/${FULL_ID}`,
      browser: "chrome",
      distDir: path.join(dir, "dist", "chrome"),
    });

    const out = JSON.parse(await handler({ projectPath: dir }));
    expect(out.value.localOnly[0].revokeUrl).toBe(
      `https://www.extension.dev/api/artifacts/${FULL_ID}`,
    );
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

  it("labels a live-filtered localOnly entry as possibly dead, not unowned", async () => {
    const dir = tmpProject();
    seedRecord(dir, GONE_ID);
    global.fetch = listingFetch({
      artifacts: [],
      count: 0,
      matched: 0,
      limit: 100,
      truncated: false,
      scanned: 1,
    });

    const out = JSON.parse(await handler({ projectPath: dir, status: "live" }));
    expect(out.value.localOnly).toHaveLength(1);
    expect(out.value.localOnly[0].status).toContain("live-only");
    expect(out.value.localOnly[0].status).not.toContain("not owned by this token");
    expect(out.value.localOnly[0].status).toContain('status:"all"');
    expect(out.hint).not.toContain("without an artifact behind them");
    expect(out.hint).toContain('status:"all"');
  });

  it("still calls an unfiltered whole-list miss not owned by this token", async () => {
    const dir = tmpProject();
    seedRecord(dir, GONE_ID);
    global.fetch = listingFetch({
      artifacts: [],
      count: 0,
      matched: 0,
      limit: 100,
      truncated: false,
      scanned: 1,
    });

    const out = JSON.parse(await handler({ projectPath: dir }));
    expect(out.value.server.truncatedReported).toBe(true);
    expect(out.value.localOnly[0].status).toContain("not owned by this token");
    expect(out.hint).toContain("without an artifact behind them");
  });

  it("refuses that same verdict when the server never sent truncated at all", async () => {
    const dir = tmpProject();
    seedRecord(dir, GONE_ID);
    global.fetch = listingFetch({
      artifacts: [],
      count: 0,
      matched: 0,
      limit: 100,
      scanned: 1,
    });

    const out = JSON.parse(await handler({ projectPath: dir }));
    expect(out.value.server.truncatedReported).toBe(false);
    expect(out.value.localOnly[0].status).toContain("unknown");
    expect(out.value.localOnly[0].status).not.toContain(
      "not owned by this token",
    );
    expect(out.value.server.truncatedNote).toContain("cannot be called whole");
    expect(
      out.warnings.some((w: string) => w.includes("cannot be called whole")),
    ).toBe(true);
  });

  it("does not call a past-its-expiry record expired on a listing it cannot call whole", async () => {
    const dir = tmpProject();
    seedRecord(dir, GONE_ID, "2026-01-01T00:00:00.000Z");
    global.fetch = listingFetch({
      artifacts: [],
      count: 0,
      matched: 0,
      limit: 100,
      scanned: 4,
    });

    const out = JSON.parse(await handler({ projectPath: dir }));
    expect(out.value.localOnly[0].status).toContain("unknown");
  });

  it("keeps truncated:true distinguishable from truncated absent", async () => {
    const dir = tmpProject();
    seedRecord(dir, GONE_ID);
    global.fetch = listingFetch({
      artifacts: [],
      count: 0,
      matched: 40,
      limit: 100,
      truncated: true,
      scanned: 200,
    });

    const cut = JSON.parse(await handler({ projectPath: dir }));
    expect(cut.value.server.truncated).toBe(true);
    expect(cut.value.server.truncatedReported).toBe(true);
    expect(cut.value.localOnly[0].status).toContain("cut short");

    global.fetch = listingFetch({
      artifacts: [],
      count: 0,
      matched: 0,
      limit: 100,
      scanned: 1,
    });
    const unsaid = JSON.parse(await handler({ projectPath: dir }));
    expect(unsaid.value.server.truncated).toBe(false);
    expect(unsaid.value.localOnly[0].status).toContain("did not say");
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

  it("does not claim a permanent revocation the platform did not confirm", async () => {
    global.fetch = listingFetch({ artifactId: LOCAL_ID, revoked: false });
    const out = JSON.parse(
      await handler({ action: "revoke", artifactId: LOCAL_ID }),
    );
    expect(out.ok).toBe(true);
    expect(out.status).toBe("revoke-unconfirmed");
    expect(out.value.revoked).toBe(false);
    expect(
      out.warnings.some((w: string) => w.includes("permanently")),
    ).toBe(false);
    expect(
      out.warnings.some((w: string) => w.includes("did not confirm")),
    ).toBe(true);
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
