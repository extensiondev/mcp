import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as builds, schema } from "../tools/builds";
import { outcomeClock } from "../lib/act-outcome";
import { TOOL_POLICY } from "../lib/tool-policy";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
const RUN_URL = "https://github.com/mirror/1--prj/actions/runs/7001";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const BUILD_ROW = {
  id: "603fc8a",
  buildId: "603fc8a",
  commit: "603fc8ab0ff0ac1dae1c598428ce49ad43081c98",
  shortSha: "603fc8a",
  status: "success",
  version: "0.1.0",
  buildEnv: "production",
  timestamp: "2026-10-11T16:45:37Z",
  startedAt: "2026-10-11T16:45:37Z",
  completedAt: "2026-10-11T16:45:37Z",
  branch: "main",
  message: "Start a tiny sandbox extension",
  duration: "1m 6s",
  browsers: ["chrome", "firefox"],
  channel: "preview",
  summaryStatus: "success",
  author: "someone",
};

const DETAIL = {
  id: "603fc8a",
  buildId: "603fc8a",
  status: "success",
  commit: BUILD_ROW.commit,
  message: BUILD_ROW.message,
  version: "0.1.0",
  browsers: [
    { name: "chrome", status: "success", duration: "1m 6s", size: "-" },
    { name: "firefox", status: "success", duration: "1m 6s", size: "-" },
  ],
  validation: { checks: [{ id: "manifest", name: "Manifest validity", status: "passed" }] },
  failureCause: null,
  branch: "main",
  runUrl: RUN_URL,
};

const ARTIFACTS = [
  {
    name: "chrome-extension.zip",
    browser: "chrome",
    size: "45.4 MB",
    type: "Extension package",
    downloadUrl: "https://registry.extension.land/acme/widget/builds/603fc8a/chrome.zip",
  },
];

const INTEGRITY_CHROME = {
  ok: false,
  browser: "chrome",
  checks: [
    { id: "download-package", ok: false, title: "Download package", detail: "HTTP 401 Unauthorized" },
    { id: "zip-structure", ok: true, title: "Zip structure", detail: "ok" },
  ],
};

const LOGS = {
  buildId: "603fc8a",
  runUrl: RUN_URL,
  runUrlAvailable: true,
  items: [
    {
      browser: "chrome",
      status: "failed",
      logs: Array.from({ length: 300 }, (_, i) => ({ level: "error", message: `line ${i}` })),
    },
    { browser: "firefox", status: "success", logs: [{ level: "info", message: "ok" }] },
  ],
};

describe("extension_builds reads the platform's builds with the project's own token", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;
  let prevApi: string | undefined;
  let calls: Array<{ url: string; auth: string }>;
  let routes: Record<string, { body: unknown; status?: number }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    calls = [];
    routes = {
      "/api/cli/whoami": {
        body: { login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" },
      },
      [`/api/projects/${PROJECT_ID}/builds`]: { body: { items: [BUILD_ROW], latest: BUILD_ROW } },
      [`/api/projects/${PROJECT_ID}/builds/603fc8a`]: { body: DETAIL },
      [`/api/projects/${PROJECT_ID}/builds/603fc8a/artifacts`]: { body: ARTIFACTS },
      [`/api/projects/${PROJECT_ID}/builds/603fc8a/integrity/chrome`]: { body: INTEGRITY_CHROME },
      [`/api/projects/${PROJECT_ID}/builds/603fc8a/integrity/firefox`]: {
        body: { ok: true, browser: "firefox", checks: [{ id: "zip-structure", ok: true }] },
      },
      [`/api/projects/${PROJECT_ID}/builds/603fc8a/usage`]: { body: { markdown: null, updatedAt: null } },
      [`/api/projects/${PROJECT_ID}/builds/603fc8a/logs`]: { body: LOGS },
    };

    global.fetch = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: target, auth: String(headers.authorization ?? "") });
      const pathname = new URL(target).pathname;
      const route = routes[pathname];

      return route
        ? jsonResponse(route.body, route.status ?? 200)
        : jsonResponse({ message: "not found" }, 404);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function login() {
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });
  }

  it("fences its answer as untrusted CI output, and its reads ship nothing", () => {
    expect(TOOL_POLICY.extension_builds).toMatchObject({ group: "platform", untrusted: true });
    expect(TOOL_POLICY.extension_builds.ships).toBeUndefined();
  });
});
