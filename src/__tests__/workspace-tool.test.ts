import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as workspace, schema } from "../tools/workspace";
import { TOOL_POLICY } from "../lib/tool-policy";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const ALPHA_ID = "prj_alpha";
const BETA_ID = "prj_beta";

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
  currentUserLogin: "someone",
  projectCount: 2,
  memberCount: 3,
  principal: "token",
};

const PLAN = {
  plan: "pro",
  month: "2026-10",
  billingOpen: false,
  countersReadable: true,
  limits: {
    projects: 10,
    buildsPerMonth: 350,
    buildBurstPerWindow: 30,
    buildBurstWindowMinutes: 60,
    unattendedBuildsPerMonth: 350,
    shareTtlDays: 365,
    safariSubmissions: 15,
    safariSubmissionsPeriod: "month",
  },
  used: { projects: 2, buildsThisMonth: 4, unattendedBuildsThisMonth: 0, sharesThisMonth: 2, safariSubmissions: 0 },
  refusals: { total: 1, byReason: { monthly_cap: 0, burst_cap: 1 }, lastReason: "burst_cap" },
};

const PROJECTS = {
  projects: [
    {
      id: ALPHA_ID,
      slug: "alpha",
      displayName: "Alpha",
      description: "First",
      visibility: "private",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
      browsers: ["chrome", "firefox"],
      channels: ["preview", "stable"],
      lastBuild: {
        status: "failed",
        jobs: [
          { browser: "chrome", status: "success", conclusion: "success" },
          { browser: "firefox", status: "failed", conclusion: "failure" },
        ],
      },
    },
    {
      id: BETA_ID,
      slug: "beta",
      displayName: "Beta",
      description: "",
      visibility: "private",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      browsers: ["chrome"],
      channels: [],
      lastBuild: null,
    },
  ],
  total: 2,
  workspace: "acme",
  version: "authority-v1",
};

const USAGE = {
  period: "2026-10",
  generatedAt: "2026-10-12T00:00:00.000Z",
  totals: { billableMinutes: 18, runCount: 19, grossAmountUsd: 0.11, netAmountUsd: 0 },
  projects: [
    {
      projectId: ALPHA_ID,
      slug: "alpha",
      displayName: "Alpha",
      billableMinutes: 18,
      runCount: 19,
      grossAmountUsd: 0.11,
      netAmountUsd: 0,
      shareOfWorkspace: 1,
      skus: [{ sku: "Actions Linux", unitType: "Minutes", quantity: 18, grossAmountUsd: 0.11 }],
    },
  ],
};

const GENERAL = { displayName: "Alpha", description: "First", url: "", supportUrl: "", visibility: "private", version: "1.0.0" };

const BUILD = {
  buildSettings: {
    chrome: { enabled: true, installCommand: "npm install", buildCommand: "npm run build -- --browser chrome", outputDirectory: "dist/chrome" },
    edge: { enabled: false, installCommand: "npm install", buildCommand: "npm run build -- --browser edge", outputDirectory: "dist/edge" },
    firefox: { enabled: true, installCommand: "npm install", buildCommand: "npm run build -- --browser firefox", outputDirectory: "dist/firefox" },
    safari: { enabled: false, installCommand: "", buildCommand: "", outputDirectory: "" },
  },
  enabledBrowsers: { chrome: true, edge: false, firefox: true, safari: false },
};

describe("extension_workspace reads a workspace with any project login it holds", () => {
  let tmp: string;
  let saved: Record<string, string | undefined>;
  let prevFetch: typeof fetch;
  let calls: Array<{ url: string; auth: string }>;
  let routes: Record<string, { body: unknown; status?: number }>;
  const whoami: Record<string, { projectId: string; workspaceSlug: string; projectSlug: string }> = {
    "Bearer alpha.sig": { projectId: ALPHA_ID, workspaceSlug: "acme", projectSlug: "alpha" },
    "Bearer beta.sig": { projectId: BETA_ID, workspaceSlug: "acme", projectSlug: "beta" },
    "Bearer other.sig": { projectId: "prj_other", workspaceSlug: "globex", projectSlug: "tool" },
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-workspace-"));
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
      "/api/workspaces/acme/plan": { body: PLAN },
      "/api/workspaces/acme/usage": { body: USAGE },
      "/api/projects": { body: PROJECTS },
      [`/api/projects/${ALPHA_ID}/settings/general`]: { body: GENERAL },
      [`/api/projects/${ALPHA_ID}/settings/build`]: { body: BUILD },
    };

    global.fetch = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = String(headers.authorization ?? "");
      calls.push({ url: target, auth });
      const pathname = new URL(target).pathname;

      if (pathname === "/api/cli/whoami") {
        const who = whoami[auth];

        return who ? jsonResponse({ live: true, ...who }) : jsonResponse({ message: "bad" }, 401);
      }

      const route = routes[pathname];

      return route ? jsonResponse(route.body, route.status ?? 200) : jsonResponse({ message: "not found" }, 404);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function login(workspaceSlug: string, projectSlug: string, token: string, api = API) {
    writeCredentials({
      version: 1,
      token,
      workspaceSlug,
      projectSlug,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api,
    });
  }

  it("is a read-only platform tool fenced as untrusted, since names and build commands are user-written", () => {
    expect(TOOL_POLICY.extension_workspace).toMatchObject({
      group: "platform",
      untrusted: true,
      annotations: { readOnlyHint: true, destructiveHint: false },
    });

    expect(schema.inputSchema.properties.action.enum).toEqual(["info", "projects", "usage", "settings"]);
  });

  it("reads the workspace and its plan by default, from the stored login's workspace", async () => {
    if (process.platform === "win32") return;

    login("acme", "alpha", "alpha.sig");

    const out = JSON.parse(await workspace({ api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("read");
    expect(out.value.action).toBe("info");
    expect(out.value.workspace).toMatchObject({ slug: "acme", role: "owner", actingAs: "someone", projectCount: 2, memberCount: 3 });
    expect(out.value.plan).toMatchObject({ plan: "pro", month: "2026-10", limits: { buildsPerMonth: 350 }, used: { buildsThisMonth: 4 } });
    expect(out.value.plan.refusals).toEqual({ total: 1, byReason: { burst_cap: 1 }, lastReason: "burst_cap" });
    expect(out.value.login).toBe("acme/alpha");
    expect(out.value.console.plan).toContain("/acme/settings/plan");
    expect(out.value.console.members).toContain("/acme/settings/members");
    expect(out.hint).toContain("console");
    expect(calls.every((call) => call.url.startsWith(API))).toBe(true);
    expect(calls.every((call) => call.auth === "Bearer alpha.sig")).toBe(true);
  });

  it("lists the projects with each browser's last build and the channels", async () => {
    if (process.platform === "win32") return;

    login("acme", "alpha", "alpha.sig");

    const out = JSON.parse(await workspace({ action: "projects", api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.total).toBe(2);
    expect(out.value.projects[0]).toMatchObject({
      project: "acme/alpha",
      projectId: ALPHA_ID,
      displayName: "Alpha",
      channels: ["preview", "stable"],
      lastBuild: { status: "failed", browsers: { chrome: "success", firefox: "failure" } },
      loggedIn: true,
    });

    expect(out.value.projects[1]).toMatchObject({ project: "acme/beta", lastBuild: null, loggedIn: false });
    expect(out.value.projects[0].consoleUrl).toContain("/acme/alpha");
    expect(calls.some((call) => call.url === `${API}/api/projects?workspace=acme`)).toBe(true);
  });

  it("reads the usage period totals and each project's share", async () => {
    if (process.platform === "win32") return;

    login("acme", "alpha", "alpha.sig");

    const out = JSON.parse(await workspace({ action: "usage", api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.period).toBe("2026-10");
    expect(out.value.totals).toEqual(USAGE.totals);
    expect(out.value.projects[0]).toMatchObject({ project: "acme/alpha", billableMinutes: 18, shareOfWorkspace: 1 });
    expect(out.value.console.usage).toContain("/acme/settings/usage");
  });

  it("serves a named workspace with any login of that workspace on the server, not the default login", async () => {
    if (process.platform === "win32") return;

    login("acme", "beta", "beta.sig");
    login("globex", "tool", "other.sig");

    const out = JSON.parse(await workspace({ workspace: "acme", api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.login).toBe("acme/beta");
    expect(calls.every((call) => call.auth === "Bearer beta.sig")).toBe(true);
  });

  it("ignores a login of that workspace minted on another server", async () => {
    login("acme", "alpha", "alpha.sig", "https://www.extension.dev");
    login("globex", "tool", "other.sig");

    const out = JSON.parse(await workspace({ workspace: "acme", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("auth-required");
    expect(out.error.code).toBe("E_AUTH_REQUIRED");
    expect(out.error.message).toContain('workspace: "acme", projects: "*"');
    expect(calls).toHaveLength(0);
  });

  it("answers another workspace's refusal by telling the agent to log in to a project of it", async () => {
    if (process.platform === "win32") return;

    login("acme", "alpha", "alpha.sig");
    routes["/api/workspaces/globex"] = {
      status: 403,
      body: { code: "TOKEN_WORKSPACE_MISMATCH", message: "This token belongs to another workspace. Log in to a project of this workspace to read it." },
    };

    const out = JSON.parse(await workspace({ workspace: "globex", project: "acme/alpha", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("refused");
    expect(out.error.code).toBe("E_AUTH_DENIED");
    expect(out.error.platformCode).toBe("TOKEN_WORKSPACE_MISMATCH");
    expect(out.error.name).toBe("TokenWorkspaceMismatch");
    expect(out.hint).toContain('extension_auth (action: "login", workspace: "globex", projects: "*")');
  });

  it("says a minter who left the workspace disarms the login", async () => {
    if (process.platform === "win32") return;

    login("acme", "alpha", "alpha.sig");
    routes["/api/workspaces/acme"] = {
      status: 403,
      body: { code: "FORBIDDEN", message: "The account that minted this token is no longer a member of this workspace." },
    };

    const out = JSON.parse(await workspace({ api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("refused");
    expect(out.error.platformCode).toBe("FORBIDDEN");
    expect(out.hint).toContain("current member");
  });

  it("reads a project's general and build settings with that project's own login", async () => {
    if (process.platform === "win32") return;

    login("acme", "alpha", "alpha.sig");

    const out = JSON.parse(await workspace({ action: "settings", project: "acme/alpha", api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.project).toBe("acme/alpha");
    expect(out.value.general).toEqual(GENERAL);
    expect(out.value.build.chrome).toEqual(BUILD.buildSettings.chrome);
    expect(out.value.enabledBrowsers).toEqual(["chrome", "firefox"]);
    expect(out.value.consoleUrl).toContain("/acme/alpha/project-settings");
    expect(out.hint).toContain("extension_builds (action: 'configure')");
    expect(out.hint).not.toContain("not here");
  });

  it("asks for that project's login when settings name a project this machine has none for", async () => {
    login("acme", "alpha", "alpha.sig");

    const out = JSON.parse(await workspace({ action: "settings", project: "acme/beta", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("auth-required");
    expect(calls).toHaveLength(0);
  });

  it("answers the platform hold with the hold envelope", async () => {
    if (process.platform === "win32") return;

    login("acme", "alpha", "alpha.sig");
    routes["/api/workspaces/acme"] = {
      status: 403,
      body: { code: "PLATFORM_NOT_OPEN", message: "extension.dev is not open to the public yet." },
    };

    const out = JSON.parse(await workspace({ api: API }));

    expect(out.status).toBe("platform-held");
  });

  it("refuses an unknown action before asking the platform", async () => {
    login("acme", "alpha", "alpha.sig");

    const out = JSON.parse(await workspace({ action: "billing", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("console");
    expect(calls).toHaveLength(0);
  });
});
