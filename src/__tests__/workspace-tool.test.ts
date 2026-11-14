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

  it("is a platform tool fenced as untrusted, since names and build commands are user-written, and no longer read-only since it writes visibility and project settings", () => {
    expect(TOOL_POLICY.extension_workspace).toMatchObject({
      group: "platform",
      untrusted: true,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    });

    expect(schema.inputSchema.properties.action.enum).toEqual(["info", "projects", "usage", "settings", "set-visibility", "configure-project", "set-environment"]);
  });
});
