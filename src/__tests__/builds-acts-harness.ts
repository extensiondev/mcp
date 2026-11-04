import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach } from "vitest";

import { writeCredentials } from "../lib/credentials";

export const SUITE = "extension_builds starts a rebuild, changes build settings as a plain call, and adds a channel";
export const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
export const SETTINGS_ROUTE = `/api/projects/${PROJECT_ID}/settings/build`;
export const DISPATCH_ROUTE = `/api/projects/${PROJECT_ID}/builds/dispatch`;
export const CHANNELS_ROUTE = `/api/projects/${PROJECT_ID}/channels`;

export type Reply = { body: unknown; status?: number; headers?: Record<string, string> };
export type Call = { url: string; method: string; auth: string; body: any };

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

export const CURRENT = {
  chrome: { enabled: true, installCommand: "npm install", buildCommand: "npm run build -- --browser chrome", outputDirectory: "dist/chrome" },
  edge: { enabled: false, installCommand: "npm install", buildCommand: "npm run build -- --browser edge", outputDirectory: "dist/edge" },
  firefox: { enabled: true, installCommand: "npm install", buildCommand: "npm run build -- --browser firefox", outputDirectory: "dist/firefox" },
  safari: { enabled: false, installCommand: "", buildCommand: "", outputDirectory: "" },
};

export const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

export function digestOf(settings: Record<string, any>): string {
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

export const world = {
  calls: [] as Call[],
  routes: {} as Record<string, (call: Call) => Reply>,
};

let tmp: string;
let prevXdg: string | undefined;
let prevApi: string | undefined;
let prevFetch: typeof fetch;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-acts-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  prevApi = process.env.EXTENSION_DEV_API_URL;
  delete process.env.EXTENSION_DEV_API_URL;
  process.env.XDG_CONFIG_HOME = tmp;
  prevFetch = global.fetch;
  world.calls = [];
  world.routes = {
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
    world.calls.push(call);
    const route = world.routes[`${method} ${new URL(target).pathname}`];

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

export function login() {
  writeCredentials({
    version: 1,
    token: "claims.sig",
    workspaceSlug: "acme",
    projectSlug: "widget",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    api: API,
  });
}
