import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as builds, schema } from "../tools/builds";
import { TOOL_POLICY } from "../lib/tool-policy";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
const SETTINGS_ROUTE = `/api/projects/${PROJECT_ID}/settings/build`;
const DISPATCH_ROUTE = `/api/projects/${PROJECT_ID}/builds/dispatch`;
const CHANNELS_ROUTE = `/api/projects/${PROJECT_ID}/channels`;

type Reply = { body: unknown; status?: number; headers?: Record<string, string> };
type Call = { url: string; method: string; auth: string; body: any };

function reply({ body, status = 200, headers = {} }: Reply): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const CURRENT = {
  chrome: { enabled: true, installCommand: "npm install", buildCommand: "npm run build -- --browser chrome", outputDirectory: "dist/chrome" },
  edge: { enabled: false, installCommand: "npm install", buildCommand: "npm run build -- --browser edge", outputDirectory: "dist/edge" },
  firefox: { enabled: true, installCommand: "npm install", buildCommand: "npm run build -- --browser firefox", outputDirectory: "dist/firefox" },
  safari: { enabled: false, installCommand: "", buildCommand: "", outputDirectory: "" },
};

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

function digestOf(settings: Record<string, any>): string {
  const canonical: Record<string, unknown> = {};

  for (const browser of ["chrome", "edge", "firefox", "safari"]) {
    const config = settings[browser];
    if (!config) continue;

    canonical[browser] = {
      enabled: config.enabled,
      installCommand: config.installCommand,
      buildCommand: config.buildCommand,
      outputDirectory: config.outputDirectory,
    };
  }

  return sha256(JSON.stringify(canonical));
}

describe("extension_builds rebuild through the hosted connection asks an owner first", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;
  let calls: Call[];
  let routes: Record<string, (call: Call) => Reply>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-acts-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    calls = [];
    routes = {
      "GET /api/cli/whoami": () => ({
        body: { login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" },
      }),
      [`GET ${SETTINGS_ROUTE}`]: () => ({
        body: { buildSettings: CURRENT, enabledBrowsers: { chrome: true, edge: false, firefox: true, safari: false } },
      }),
    };

    global.fetch = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const method = String(init?.method ?? "GET").toUpperCase();
      const call: Call = {
        url: target,
        method,
        auth: String(headers.authorization ?? ""),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const route = routes[`${method} ${new URL(target).pathname}`];

      return reply(route ? route(call) : { body: { message: "not found" }, status: 404 });
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

  const FULL_SHA = "603fc8a1234567890abcdef1234567890abcdef1";
  const rebuildFingerprint = (buildEnv: string) =>
    sha256(`extension_builds.rebuild\nbuildEnv=${buildEnv}\ncommit=${FULL_SHA}`);

  it("rebuild a connected app starts asks an owner to approve that exact commit and hands back the link", async () => {
    if (process.platform === "win32") return;

    login();
    const approvalRequest = {
      action: "extension_builds.rebuild",
      scope: { commit: FULL_SHA, buildEnv: "staging" },
      fingerprint: rebuildFingerprint("staging"),
    };
    routes[`POST ${DISPATCH_ROUTE}`] = () => ({
      body: { code: "APPROVAL_REQUIRED", message: "needs approval", approvalRequest },
      status: 403,
    });

    routes["POST /api/cli/approvals"] = () => ({
      status: 201,
      body: {
        approvalId: "apr_r1",
        approvalUrl: "http://localhost:3100/device/approve/apr_r1",
        expiresAt: "2026-10-15T20:00:00.000Z",
        description: "Rebuild widget at 603fc8a for staging.",
      },
    });

    const out = JSON.parse(await builds({ action: "rebuild", api: API }));
    const post = calls.find((call) => call.method === "POST" && call.url.endsWith("/api/cli/approvals"));

    expect(post?.body).toMatchObject(approvalRequest);
    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-required");
    expect(out.value).toMatchObject({ approvalId: "apr_r1", approvalUrl: "http://localhost:3100/device/approve/apr_r1" });
    expect(out.error.message).toContain("apr_r1");
    expect(out.error.message).toContain(FULL_SHA);
    expect(calls.filter((call) => call.url.endsWith("/builds/dispatch"))).toHaveLength(1);
  });

  it("rebuild refuses an approval request whose fingerprint this server cannot reproduce", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`POST ${DISPATCH_ROUTE}`] = () => ({
      body: {
        code: "APPROVAL_REQUIRED",
        message: "needs approval",
        approvalRequest: { action: "extension_builds.rebuild", scope: { commit: FULL_SHA, buildEnv: "staging" }, fingerprint: "0".repeat(64) },
      },
      status: 403,
    });

    const out = JSON.parse(await builds({ action: "rebuild", api: API }));

    expect(out.ok).toBe(false);
    expect(calls.some((call) => call.url.endsWith("/api/cli/approvals"))).toBe(false);
  });

  it("rebuild with an approvalId needs the full commit sha the approval names", async () => {
    if (process.platform === "win32") return;

    login();
    const out = JSON.parse(await builds({ action: "rebuild", approvalId: "apr_r1", buildId: "603fc8a", api: API }));

    expect(out.status).toBe("bad-request");
    expect(calls.some((call) => call.url.endsWith("/builds/dispatch"))).toBe(false);
  });

  it("rebuild with a pending approval dispatches nothing", async () => {
    if (process.platform === "win32") return;

    login();
    routes["GET /api/cli/approvals/apr_r1"] = () => ({ body: { status: "pending", used: false } });

    const out = JSON.parse(await builds({ action: "rebuild", approvalId: "apr_r1", buildId: FULL_SHA, api: API }));

    expect(out.status).toBe("approval-pending");
    expect(calls.some((call) => call.url.endsWith("/builds/dispatch"))).toBe(false);
  });

  it("rebuild with an approved approval dispatches once, naming the commit and the approval", async () => {
    if (process.platform === "win32") return;

    login();
    routes["GET /api/cli/approvals/apr_r1"] = () => ({
      body: { status: "approved", used: false, fingerprint: rebuildFingerprint("production"), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    routes[`POST ${DISPATCH_ROUTE}`] = () => ({
      body: { commit: "603fc8a", branch: "main", browsers: "chrome", origin: "mcp" },
    });

    const out = JSON.parse(
      await builds({ action: "rebuild", approvalId: "apr_r1", buildId: FULL_SHA, buildEnv: "production", api: API }),
    );
    const dispatches = calls.filter((call) => call.url.endsWith("/builds/dispatch"));

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].body).toEqual({ origin: "mcp", buildEnv: "production", commitSha: FULL_SHA, approvalId: "apr_r1" });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("dispatched");
  });

  it("rebuild with a used approval says the run may already exist and dispatches nothing", async () => {
    if (process.platform === "win32") return;

    login();
    routes["GET /api/cli/approvals/apr_r1"] = () => ({
      body: { status: "approved", used: true, fingerprint: rebuildFingerprint("staging"), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    const out = JSON.parse(await builds({ action: "rebuild", approvalId: "apr_r1", buildId: FULL_SHA, api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("ApprovalConsumed");
    expect(calls.some((call) => call.url.endsWith("/builds/dispatch"))).toBe(false);
  });
});
