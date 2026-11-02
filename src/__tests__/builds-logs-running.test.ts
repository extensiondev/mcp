import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler as builds } from "../tools/builds";
import { outcomeClock } from "../lib/act-outcome";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
const SHA = "41a0c7e";
const BUILD_ROUTE = `/api/projects/${PROJECT_ID}/builds/${SHA}`;
const READ_AT = "2026-11-02T01:05:03.000Z";

type Route = { body?: unknown; status?: number; raw?: string };

function response(route: Route): Response {
  const status = route.status ?? 200;
  const textBody = route.raw !== undefined ? route.raw : JSON.stringify(route.body ?? null);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => textBody,
    json: async () => JSON.parse(textBody),
  } as unknown as Response;
}

function running(status: string): { buildId: string; run: Record<string, unknown>; items: Array<Record<string, unknown>> } {
  return {
    buildId: SHA,
    run: { status, conclusion: null, failedJob: null },
    items: [
      { browser: "chrome", status: "pending", logs: [] },
      { browser: "firefox", status: "pending", logs: [] },
    ],
  };
}

describe("extension_builds logs says a running build has no lines yet instead of listing empty logs as its lines", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;
  let calls: string[];
  let routes: Record<string, Route>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-logs-running-"));
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
      [`${BUILD_ROUTE}/usage`]: { body: { markdown: null, updatedAt: null } },
      [`${BUILD_ROUTE}/integrity/chrome`]: { raw: "" },
      [`${BUILD_ROUTE}/integrity/firefox`]: { raw: "" },
    };

    global.fetch = (async (url: string) => {
      const pathname = new URL(String(url)).pathname;
      calls.push(pathname);
      const route = routes[pathname];

      return route ? response(route) : response({ body: { message: "not found" }, status: 404 });
    }) as unknown as typeof fetch;

    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    global.fetch = prevFetch;
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("names the read time and points at get for progress while the run is in progress", async () => {
    if (process.platform === "win32") return;

    routes[`${BUILD_ROUTE}/logs`] = { body: running("in_progress") };
    vi.spyOn(outcomeClock, "now").mockReturnValue(Date.parse(READ_AT));

    const out = JSON.parse(await builds({ action: "logs", buildId: SHA, api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.readAt).toBe(READ_AT);
    expect(out.value.run.status).toBe("in_progress");
    expect(out.hint).toContain(`The run is in_progress as of ${READ_AT}, so chrome, firefox have no lines yet`);
    expect(out.hint).toContain('extension_builds action:"get" with this buildId shows each browser\'s progress now');
    expect(out.hint).not.toContain("Log lines for");
    expect(out.value.items.map((item: { reason?: string }) => item.reason)).toEqual([
      "the run is still in progress, and the platform reports a browser's lines once the build records them",
      "the run is still in progress, and the platform reports a browser's lines once the build records them",
    ]);
  });

  it("keeps the plain lines answer once a browser has lines", async () => {
    if (process.platform === "win32") return;

    const body = running("in_progress");
    body.items = [{ browser: "chrome", status: "success", logs: [{ level: "info", message: "built" }] }];
    routes[`${BUILD_ROUTE}/logs`] = { body };

    const out = JSON.parse(await builds({ action: "logs", buildId: SHA, api: API }));

    expect(out.hint).toContain("Log lines for chrome.");
    expect(out.value.items[0].reason).toBeUndefined();
  });
});
