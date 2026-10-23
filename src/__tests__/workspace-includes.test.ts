import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as workspace, schema } from "../tools/workspace";
import { includesOf } from "../tools/workspace-reads";
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

  it("offers include with the five sections and keeps the action enum", () => {
    const props = schema.inputSchema.properties as Record<string, { enum?: string[]; items?: { enum: string[] } }>;

    expect(props.include.items?.enum).toEqual(["team", "members", "tokens", "apps", "activity"]);
    expect(props.action.enum).toEqual(["info", "projects", "usage", "settings"]);
    expect(schema.description).toContain("include: ['team','members','tokens','apps','activity']");
    expect(includesOf(["team", "team", "nope", 3])).toEqual({ sections: ["team"], bad: ["nope", "3"] });
  });

  it("adds every section to the info answer, each with its console page", async () => {
    if (process.platform === "win32") return;

    const raw = await workspace({ include: ["team", "members", "tokens", "apps", "activity"], api: API });
    const out = JSON.parse(raw);

    expect(out.ok).toBe(true);
    expect(out.status).toBe("read");
    expect(out.value.action).toBe("info");
    expect(out.value.workspace.slug).toBe("acme");
    expect(out.value.project).toBe("acme/alpha");

    expect(out.value.team.members).toEqual([
      { login: "octocat", role: "owner", joinedAt: "2026-01-01T00:00:00.000Z" },
      { login: "hubot", role: "member", joinedAt: "2026-02-01T00:00:00.000Z" },
    ]);

    expect(out.value.team.invites).toEqual([{ id: "inv_1", email: "a***@acme.test", role: "member", invitedBy: "octocat", createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-08T00:00:00.000Z" }]);
    expect(out.value.team.consoleUrl).toContain("/acme/alpha/");
    expect(out.value.team.consoleUrl).toContain("team");

    expect(out.value.members.members).toHaveLength(2);
    expect(out.value.members.invites).toEqual([]);
    expect(out.value.members.consoleUrl).toContain("/acme/settings/members");

    expect(out.value.tokens.tokens).toEqual([
      { id: "tokA1234567", label: "mcp", kind: "api", createdAt: "2026-10-20T10:00:00.000Z", expiresAt: "2099-10-27T10:00:00.000Z", notAfter: null, issuedBy: "octocat", build: null, lastUsedAt: null, revoked: false, revokedAt: null, revokedBy: null },
      { id: "shrB1234567", label: "testers", kind: "share", createdAt: "2026-10-21T10:00:00.000Z", expiresAt: "2099-10-28T10:00:00.000Z", notAfter: null, issuedBy: "octocat", build: "0c7471e", lastUsedAt: null, revoked: true, revokedAt: "2026-10-22T10:00:00.000Z", revokedBy: "octocat" },
    ]);

    expect(out.value.tokens.consoleUrl).toContain("access-tokens");

    expect(out.value.apps.apps).toEqual([
      { id: "grant_1", name: "Claude Code", redirectHost: "localhost", connectedBy: "octocat", projects: ["alpha"], connectedAt: "2026-10-15T10:00:00.000Z", lastRefreshedAt: null, expiresAt: "2027-10-15T10:00:00.000Z" },
    ]);

    expect(out.value.apps.consoleUrl).toContain("connected-apps");

    expect(out.value.activity.total).toBe(2);
    expect(out.value.activity.entries[0]).toEqual({
      id: "0c7471e",
      category: "builds",
      event: "build_succeeded",
      status: "success",
      at: "2026-10-22T10:00:00.000Z",
      details: { commit: "0c7471e", message: "Ship it", branch: "main", browsers: [{ name: "chrome", status: "success" }], actor: { login: "octocat", displayName: "Octo" } },
    });

    expect(out.value.activity.entries[1].details).toEqual({ version: "1.2.0", channel: "stable", browser: "chrome" });
    expect(out.value.activity.consoleUrl).toContain("/acme/alpha/activity");

    expect(out.hint).toContain("The project team has 2 members and 1 pending invite");
    expect(out.hint).toContain("acme has 2 members and 0 pending invites");
    expect(out.hint).toContain("1 of 2 access tokens");
    expect(out.hint).toContain("1 connected app holds");
    expect(out.hint).toContain("2 newest entries (of 2)");
    expect(calls.find((call) => call.pathname.endsWith("/activity"))?.search).toBe("?limit=50");
    expect(calls.every((call) => call.auth === "Bearer alpha.sig")).toBe(true);
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

  it("names a section the platform did not answer and keeps the others", async () => {
    if (process.platform === "win32") return;

    routes["/api/workspaces/acme/members"] = { body: { message: "not found" }, status: 404 };
    routes[`/api/projects/${ALPHA_ID}/team/invites`] = { body: { message: "Only workspace owners can do that.", code: "OWNER_REQUIRED" }, status: 403 };

    const out = JSON.parse(await workspace({ include: ["members", "team"], api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.members).toBeUndefined();
    expect(out.value.team.members).toHaveLength(2);
    expect(out.value.team.invites).toBeNull();
    expect(out.value.team.invitesNote).toContain("403");
    expect(out.warnings.join(" ")).toContain("The workspace members could not be read: the platform in front of this server does not answer it to a token yet");
    expect(out.warnings.join(" ")).toContain("/acme/settings/members");
  });

  it("refuses an unknown section before reading anything", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await workspace({ include: ["billing"], api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("team, members, tokens, apps, activity");
    expect(calls).toHaveLength(0);
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
