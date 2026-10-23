import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as shares, schema } from "../tools/shares";
import { buildLinkView, parseBuildLinkRef } from "../lib/build-links";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const ALPHA_ID = "prj_alpha";
const LINK_ID = "Qm9vazEyMzQ";
const DEAD_ID = "RGVhZDU2Nzg";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const TOKENS = {
  items: [
    {
      id: "tok_api_1",
      kind: "api",
      label: "mcp",
      ttlDays: 7,
      issuedAt: "2026-10-20T10:00:00.000Z",
      expiresAt: "2099-10-27T10:00:00.000Z",
      issuedBy: "octocat",
      buildSha: null,
      revokedAt: null,
      revokedBy: null,
    },
    {
      id: LINK_ID,
      kind: "share",
      label: "testers",
      ttlDays: 7,
      issuedAt: "2026-10-21T10:00:00.000Z",
      expiresAt: "2099-10-28T10:00:00.000Z",
      issuedBy: "octocat",
      buildSha: "0c7471e",
      scope: "build:0c7471e",
      revokedAt: null,
      revokedBy: null,
      shareUrl: `https://acme.extension.dev/alpha?share=${LINK_ID}`,
      secretValue: "never-answered",
    },
    {
      id: DEAD_ID,
      kind: "share",
      label: null,
      ttlDays: 7,
      issuedAt: "2026-10-01T10:00:00.000Z",
      expiresAt: "2099-10-08T10:00:00.000Z",
      issuedBy: "octocat",
      buildSha: null,
      scope: "build:abcdef0",
      revokedAt: "2026-10-02T10:00:00.000Z",
      revokedBy: "octocat",
    },
  ],
};

describe("extension_shares lists and revokes build links", () => {
  let tmp: string;
  let saved: Record<string, string | undefined>;
  let prevFetch: typeof fetch;
  let calls: Array<{ method: string; pathname: string; headers: Record<string, string> }>;
  let routes: Record<string, { body: unknown; status?: number }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-build-links-"));
    saved = {};

    for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_APPROVAL_GATE"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }

    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    prevFetch = global.fetch;
    calls = [];
    routes = {
      [`GET /api/projects/${ALPHA_ID}/access-tokens`]: { body: TOKENS },
      [`DELETE /api/projects/${ALPHA_ID}/access-tokens/${LINK_ID}`]: { body: { ok: true, alreadyRevoked: false, revocations: { published: true, changed: true, reason: null } } },
      "GET /api/artifacts": { body: { artifacts: [], count: 0, matched: 0, limit: 100, truncated: false } },
    };

    global.fetch = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const method = String(init?.method ?? "GET").toUpperCase();
      const pathname = new URL(target).pathname;
      calls.push({ method, pathname, headers });

      if (pathname === "/api/cli/whoami") {
        return headers.authorization === "Bearer alpha.sig"
          ? jsonResponse({ live: true, projectId: ALPHA_ID, workspaceSlug: "acme", projectSlug: "alpha" })
          : jsonResponse({ message: "bad" }, 401);
      }

      if (pathname === "/api/cli/approvals" && method === "POST") {
        return jsonResponse({ approvalId: "apr_build_link", approvalUrl: `${API}/approvals/apr_build_link`, expiresAt: "2099-01-01T00:00:00.000Z" });
      }

      const route = routes[`${method} ${pathname}`];

      return route ? jsonResponse(route.body, route.status ?? 200) : jsonResponse({ message: "not found" }, 404);
    }) as unknown as typeof fetch;

    writeCredentials({
      version: 1,
      token: "alpha.sig",
      workspaceSlug: "acme",
      projectSlug: "alpha",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("offers kind and tokenId, with both as the default kind", () => {
    const props = schema.inputSchema.properties as Record<string, { enum?: string[]; default?: string }>;

    expect(props.kind.enum).toEqual(["build-link", "preview", "both"]);
    expect(props.kind.default).toBe("both");
    expect(props.tokenId).toBeTruthy();
    expect(schema.description).toContain("kind: build-link");
  });

  it("lists the build links alone with kind build-link, never an api token or a token value", async () => {
    if (process.platform === "win32") return;

    const raw = await shares({ action: "list", kind: "build-link", api: API });
    const out = JSON.parse(raw);

    expect(out.ok).toBe(true);
    expect(out.status).toBe("listed");
    expect(out.value).toMatchObject({ action: "list", kind: "build-link", project: "acme/alpha", server: { listed: true, count: 2, live: 1, liveOnly: false } });
    expect(out.value.buildLinks).toHaveLength(2);
    expect(out.value.buildLinks[0]).toEqual({
      id: LINK_ID,
      kind: "build-link",
      label: "testers",
      build: "0c7471e",
      scope: "build:0c7471e",
      audience: "anyone holding the link, until it expires or is revoked",
      issuedBy: "octocat",
      createdAt: "2026-10-21T10:00:00.000Z",
      expiresAt: "2099-10-28T10:00:00.000Z",
      notAfter: null,
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
      live: true,
      shareUrl: `https://acme.extension.dev/alpha?share=${LINK_ID}`,
    });

    expect(out.value.buildLinks[1]).toMatchObject({ id: DEAD_ID, build: "abcdef0", live: false, revokedAt: "2026-10-02T10:00:00.000Z" });
    expect(raw).not.toContain("tok_api_1");
    expect(raw).not.toContain("never-answered");
    expect(out.value.consoleUrl).toContain("/acme/alpha/");
    expect(out.value.consoleUrl).toContain("share-links");
    expect(out.hint).toContain("1 of 2 build links still open");
    expect(out.warnings.join(" ")).toContain("does not record when a link was last opened");
    expect(calls.some((call) => call.pathname === "/api/artifacts")).toBe(false);
  });

  it("filters to the open links with status live", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await shares({ action: "list", kind: "build-link", status: "live", api: API }));

    expect(out.value.buildLinks.map((row: { id: string }) => row.id)).toEqual([LINK_ID]);
    expect(out.value.server).toMatchObject({ count: 1, live: 1, liveOnly: true });
  });

  it("lists both kinds by default, with the build links beside the preview shares", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await shares({ action: "list", api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("listed");
    expect(out.value.kind).toBe("both");
    expect(out.value.shares).toEqual([]);
    expect(out.value.buildLinks).toHaveLength(2);
    expect(out.value.buildLinksConsoleUrl).toContain("share-links");
    expect(out.hint).toContain("build links still open");
    expect(calls.some((call) => call.pathname === "/api/artifacts")).toBe(true);
    expect(calls.some((call) => call.pathname.endsWith("/access-tokens"))).toBe(true);
  });

  it("says the build links are unknown, not none, when their list failed", async () => {
    if (process.platform === "win32") return;

    routes[`GET /api/projects/${ALPHA_ID}/access-tokens`] = { body: { message: "boom" }, status: 500 };

    const out = JSON.parse(await shares({ action: "list", api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.buildLinks).toBeNull();
    expect(out.warnings.join(" ")).toContain("unknown, not none");
    expect(out.warnings.join(" ")).toContain("500");
  });

  it("leaves the build links out with kind preview", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await shares({ action: "list", kind: "preview", api: API }));

    expect(out.value.kind).toBeUndefined();
    expect(out.value.buildLinks).toBeUndefined();
    expect(calls.some((call) => call.pathname.endsWith("/access-tokens"))).toBe(false);
  });

  it("revokes a build link by tokenId with the project's own login", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await shares({ action: "revoke", kind: "build-link", tokenId: LINK_ID, api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("revoked");
    expect(out.value).toMatchObject({ action: "revoke", kind: "build-link", tokenId: LINK_ID, project: "acme/alpha", revoked: true, alreadyRevoked: false });

    const sent = calls.find((call) => call.method === "DELETE");
    expect(sent?.pathname).toBe(`/api/projects/${ALPHA_ID}/access-tokens/${LINK_ID}`);
    expect(sent?.headers.authorization).toBe("Bearer alpha.sig");
    expect(sent?.headers["x-extensiondev-approval"]).toBeUndefined();
  });

  it("reads the build link id out of the link itself", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await shares({ action: "revoke", url: `https://acme.extension.dev/alpha?share=${LINK_ID}`, api: API }));

    expect(out.status).toBe("revoked");
    expect(out.value.tokenId).toBe(LINK_ID);
    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
  });

  it("asks for a member's approval first when the platform refuses the revoke without one", async () => {
    if (process.platform === "win32") return;

    routes[`DELETE /api/projects/${ALPHA_ID}/access-tokens/${LINK_ID}`] = {
      body: { message: "approval needed", code: "APPROVAL_REQUIRED", approvalRequest: { action: "extension_shares.revoke", scope: { tokenId: LINK_ID } } },
      status: 403,
    };

    const out = JSON.parse(await shares({ action: "revoke", kind: "build-link", tokenId: LINK_ID, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-required");
    expect(out.value.approvalId).toBe("apr_build_link");
    expect(out.value.approvalUrl).toContain("/approvals/apr_build_link");
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  it("sends the approval handle on the retry", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await shares({ action: "revoke", kind: "build-link", tokenId: LINK_ID, approvalId: "apr_build_link", api: API }));

    expect(out.status).toBe("revoked");

    const sent = calls.find((call) => call.method === "DELETE");
    expect(sent?.headers["x-extensiondev-approval"]).toBe("apr_build_link");
  });

  it("answers not-found for a link the platform does not know", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await shares({ action: "revoke", kind: "build-link", tokenId: DEAD_ID, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("not-found");
    expect(out.value.tokenId).toBe(DEAD_ID);
  });

  it("refuses a malformed reference before asking the platform", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await shares({ action: "revoke", kind: "build-link", tokenId: "no", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.value.kind).toBe("build-link");
    expect(calls).toHaveLength(0);
  });

  it("keeps a preview share revoke on the artifacts lane", async () => {
    if (process.platform === "win32") return;

    const id = `gen_${"0123456789abcdef".repeat(4)}`;
    routes[`DELETE /api/artifacts/${id}`] = { body: { artifactId: id, revoked: true } };

    const out = JSON.parse(await shares({ action: "revoke", artifactId: id, api: API }));

    expect(out.status).toBe("revoked");
    expect(out.value.artifactId).toBe(id);
    expect(calls.find((call) => call.method === "DELETE")?.pathname).toBe(`/api/artifacts/${id}`);
  });

  it("views only share records, computes live from the dates, and reads ids out of links", () => {
    const now = Date.parse("2026-10-23T00:00:00.000Z");

    expect(buildLinkView({ id: "x".repeat(11), kind: "api" }, now)).toBeNull();
    expect(buildLinkView({ id: "x".repeat(11), kind: "share", expiresAt: "2026-10-22T00:00:00.000Z" }, now)?.live).toBe(false);
    expect(buildLinkView({ id: "x".repeat(11), kind: "share", expiresAt: "2026-10-24T00:00:00.000Z", notAfter: "2026-10-22T00:00:00.000Z" }, now)?.live).toBe(false);
    expect(buildLinkView({ id: "x".repeat(11), kind: "share", expiresAt: "2026-10-24T00:00:00.000Z", scope: "channel:beta" }, now)).toMatchObject({ live: true, build: null, scope: "channel:beta" });
    expect(parseBuildLinkRef(` ${LINK_ID} `)).toBe(LINK_ID);
    expect(parseBuildLinkRef(`https://acme.extension.dev/alpha/builds/0c7471e?share=${LINK_ID}&x=1`)).toBe(LINK_ID);
    expect(parseBuildLinkRef("https://acme.extension.dev/alpha")).toBeNull();
    expect(parseBuildLinkRef("gen_abc")).toBeNull();
  });
});
