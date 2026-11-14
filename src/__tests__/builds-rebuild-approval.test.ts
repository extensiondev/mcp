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

describe("extension_builds_act rebuild through the hosted connection asks an owner first", () => {
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
});
