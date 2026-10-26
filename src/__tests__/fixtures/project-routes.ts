import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach } from "vitest";

import { writeCredentials } from "../../lib/credentials";

export const API = "http://localhost:3100";
export const PROJECT_ID = "prj_probe";
export const PROJECT_ROUTE = `/api/projects/${PROJECT_ID}`;

export type Reply = { body: unknown; status?: number; headers?: Record<string, string>; bytes?: Buffer };
export type Call = { url: string; path: string; method: string; auth: string; body: any };

function reply({ body, status = 200, headers = {}, bytes }: Reply): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
    arrayBuffer: async () => {
      const raw = bytes ?? Buffer.from(JSON.stringify(body));

      return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    },
  } as unknown as Response;
}

export interface ProjectRoutes {
  calls: Call[];
  routes: Record<string, (call: Call) => Reply>;
  login: () => void;
  sent: (method: string, pathname: string) => Call[];
}

export function useProjectRoutes(prefix: string): ProjectRoutes {
  const state: ProjectRoutes = {
    calls: [],
    routes: {},
    login: () =>
      writeCredentials({
        version: 1,
        token: "claims.sig",
        workspaceSlug: "acme",
        projectSlug: "widget",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        api: API,
      }),
    sent: (method, pathname) => state.calls.filter((call) => call.method === method && call.path === pathname),
  };
  let tmp = "";
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevGate: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    prevGate = process.env.EXTENSION_DEV_APPROVAL_GATE;
    delete process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_APPROVAL_GATE;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    state.calls.length = 0;

    for (const key of Object.keys(state.routes)) delete state.routes[key];

    state.routes["GET /api/cli/whoami"] = () => ({
      body: { login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" },
    });

    global.fetch = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const method = String(init?.method ?? "GET").toUpperCase();
      const pathname = new URL(target).pathname;
      const call: Call = {
        url: target,
        path: pathname,
        method,
        auth: String(headers.authorization ?? ""),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      state.calls.push(call);
      const route = state.routes[`${method} ${pathname}`];

      return reply(route ? route(call) : { body: { message: "not found" }, status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;
    if (prevGate === undefined) delete process.env.EXTENSION_DEV_APPROVAL_GATE;
    else process.env.EXTENSION_DEV_APPROVAL_GATE = prevGate;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  return state;
}
