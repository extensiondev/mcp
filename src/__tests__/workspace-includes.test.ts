import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as workspace, schema } from "../tools/workspace";
import { trackFields } from "../lib/track-url";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const ALPHA_ID = "prj_alpha";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const WORKSPACE = {
  id: "ws_acme",
  slug: "acme",
  displayName: "Acme",
  description: "",
  developerUrl: "",
  isImmutablePersonalWorkspace: false,
  currentUserRole: "owner",
  currentUserLogin: "octocat",
  projectCount: 1,
  memberCount: 2,
  principal: "token",
};

const TEAM = [
  { id: "octocat", name: "octocat", email: "", role: "owner", status: "active", joinedAt: "2026-01-01T00:00:00.000Z", avatar: "https://github.com/octocat.png?size=80" },
  { id: "hubot", name: "hubot", email: "", role: "member", status: "active", joinedAt: "2026-02-01T00:00:00.000Z", avatar: "https://github.com/hubot.png?size=80" },
];

const TEAM_INVITES = [{ id: "inv_1", email: "a***@acme.test", role: "member", invitedBy: "octocat", createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-08T00:00:00.000Z" }];

const MEMBERS = { workspace: "acme", members: [{ login: "octocat", role: "owner", joinedAt: "2026-01-01T00:00:00.000Z" }, { login: "hubot", role: "member", joinedAt: "2026-02-01T00:00:00.000Z" }] };

const TOKENS = {
  items: [
    { id: "tokA1234567", kind: "api", label: "mcp", ttlDays: 7, issuedAt: "2026-10-20T10:00:00.000Z", expiresAt: "2099-10-27T10:00:00.000Z", issuedBy: "octocat", buildSha: null, revokedAt: null, revokedBy: null, token: "never-answered" },
    { id: "shrB1234567", kind: "share", label: "testers", ttlDays: 7, issuedAt: "2026-10-21T10:00:00.000Z", expiresAt: "2099-10-28T10:00:00.000Z", issuedBy: "octocat", buildSha: "0c7471e", revokedAt: "2026-10-22T10:00:00.000Z", revokedBy: "octocat", shareUrl: "https://acme.extension.dev/alpha?share=shrB1234567" },
  ],
};

const APPS = {
  items: [
    { id: "grant_1", clientName: "Claude Code", redirectHost: "localhost", connectedBy: "octocat", projects: ["alpha"], connectedAt: "2026-10-15T10:00:00.000Z", lastRefreshedAt: null, expiresAt: "2027-10-15T10:00:00.000Z" },
  ],
};

const ACTIVITY = {
  items: [
    {
      id: "0c7471e",
      category: "builds",
      source: "github",
      eventKind: "build_succeeded",
      status: "success",
      number: 1,
      createdAt: "2026-10-22T10:00:00.000Z",
      details: {
        repo: "extensiondev-mirrors/acme-alpha",
        repoRef: "refs/heads/main",
        logsUrl: "https://github.com/extensiondev-mirrors/acme-alpha/actions/runs/123",
        workflowName: "Build",
        commit: "0c7471e",
        message: "Ship it",
        head_branch: "main",
        browsers: [{ name: "chrome", status: "success", duration: "1m" }],
        head_commit: { id: "0c7471e", message: "Ship it", author: { name: "Octo", email: "octo@acme.test" } },
        actor: { githubLogin: "octocat", displayName: "Octo" },
      },
    },
    { id: "rel-1", category: "releases", source: "registry", eventKind: "release_promoted", status: "promoted", number: 2, createdAt: "2026-10-21T10:00:00.000Z", details: { version: "1.2.0", channel: "stable", browser: "chrome" } },
  ],
  stats: {},
  total: 2,
  nextOffset: null,
  limit: 50,
  offset: 0,
  hasMore: false,
};

describe("extension_workspace include reads the team, members, tokens, apps and activity", () => {
  let tmp: string;
  let saved: Record<string, string | undefined>;
  let prevFetch: typeof fetch;
  let calls: Array<{ pathname: string; search: string; auth: string }>;
  let routes: Record<string, { body: unknown; status?: number }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-workspace-includes-"));
    saved = {};

    for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }

    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    calls = [];
    routes = {
      "/api/workspaces/acme": { body: WORKSPACE },
      "/api/workspaces/acme/plan": { body: { message: "no plan" }, status: 500 },
      "/api/workspaces/acme/members": { body: MEMBERS },
      "/api/workspaces/acme/members/invites": { body: [] },
      [`/api/projects/${ALPHA_ID}/team`]: { body: TEAM },
      [`/api/projects/${ALPHA_ID}/team/invites`]: { body: TEAM_INVITES },
      [`/api/projects/${ALPHA_ID}/access-tokens`]: { body: TOKENS },
      [`/api/projects/${ALPHA_ID}/connected-apps`]: { body: APPS },
      [`/api/projects/${ALPHA_ID}/activity`]: { body: ACTIVITY },
    };

    global.fetch = (async (url: string, init?: RequestInit) => {
      const target = new URL(String(url));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = String(headers.authorization ?? "");
      calls.push({ pathname: target.pathname, search: target.search, auth });

      if (target.pathname === "/api/cli/whoami") {
        return auth === "Bearer alpha.sig"
          ? jsonResponse({ live: true, projectId: ALPHA_ID, workspaceSlug: "acme", projectSlug: "alpha" })
          : jsonResponse({ message: "bad" }, 401);
      }

      const route = routes[target.pathname];

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

  it("never answers a token value, a share link, a mirror repository or a workflow run", async () => {
    if (process.platform === "win32") return;

    const raw = await workspace({ include: ["tokens", "activity"], api: API });

    expect(raw).not.toContain("never-answered");
    expect(raw).not.toContain("share=");
    expect(raw).not.toContain("extensiondev-mirrors");
    expect(raw).not.toContain("actions/runs");
    expect(raw).not.toContain("workflowName");
    expect(raw).not.toContain("octo@acme.test");
    expect(raw).not.toContain('"source"');
  });

  it("leaves the answer untouched without include", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await workspace({ api: API }));

    expect(out.value.team).toBeUndefined();
    expect(out.value.project).toBeUndefined();
    expect(calls.some((call) => call.pathname.endsWith("/team"))).toBe(false);
  });

  it("tracks each section on its own console page", () => {
    const at = (include: string[]) =>
      trackFields("extension_workspace", { args: { include, project: "acme/alpha" }, status: "read", value: { project: "acme/alpha" } })?.trackUrl ?? "";

    expect(at(["team"])).toContain("/acme/alpha/");
    expect(at(["team"])).toContain("team");
    expect(at(["tokens"])).toContain("access-tokens");
    expect(at(["apps"])).toContain("connected-apps");
    expect(at(["activity"])).toMatch(/\/acme\/alpha\/activity$/);
    expect(at(["members"])).toMatch(/\/acme\/settings\/members$/);
    expect(at([])).toMatch(/\/acme$/);
  });
});
