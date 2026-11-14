import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as shares, schema } from "../tools/shares";
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
    expect(schema.description).toContain("build link");
  });

  it("leaves the build links out with kind preview", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await shares({ action: "list", kind: "preview", api: API }));

    expect(out.value.kind).toBeUndefined();
    expect(out.value.buildLinks).toBeUndefined();
    expect(calls.some((call) => call.pathname.endsWith("/access-tokens"))).toBe(false);
  });
});
