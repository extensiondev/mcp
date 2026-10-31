import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
const SHA = "41a0c7e";
const BUILD_ROUTE = `/api/projects/${PROJECT_ID}/builds/${SHA}`;

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

function detail(status: string): Record<string, unknown> {
  return {
    id: SHA,
    buildId: SHA,
    status,
    commit: "41a0c7e9d1b2c3d4e5f60718293a4b5c6d7e8f90",
    message: "Wire the popup",
    version: "0.1.0",
    browsers: [
      { name: "chrome", status },
      { name: "firefox", status },
    ],
    branch: "main",
    startedAt: "2026-10-31T14:02:11Z",
  };
}

describe("extension_builds get reads artifacts and integrity only once the build has finished", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;
  let calls: string[];
  let routes: Record<string, Route>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-unfinished-"));
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
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each(["building", "pending"])("skips the artifact and integrity reads of a %s build and says when they arrive, with no warning", async (status) => {
    if (process.platform === "win32") return;

    routes[BUILD_ROUTE] = { body: detail(status) };

    const out = JSON.parse(await builds({ action: "get", buildId: SHA, api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("read");
    expect(out.value.build).toMatchObject({ buildId: SHA, status });
    expect(out.value.artifacts).toEqual([]);
    expect(out.value.integrity).toEqual({});
    expect(out.warnings).toEqual([]);
    expect(out.hint).toContain(`Build ${SHA} is ${status}; artifacts and integrity arrive when the build finishes.`);
    expect(out.hint).toContain('action:"logs"');
    expect(calls.filter((p) => p.endsWith("/artifacts") || p.includes("/integrity/"))).toEqual([]);
    expect(calls).toContain(`${BUILD_ROUTE}/usage`);
    expect(JSON.stringify(out)).not.toContain("/api/projects/");
  });

  it("keeps the reads of a finished build and names a missing record by the build, never by an internal address", async () => {
    if (process.platform === "win32") return;

    routes[BUILD_ROUTE] = { body: detail("success") };
    routes[`${BUILD_ROUTE}/integrity/firefox`] = { body: { message: "not found" }, status: 404 };

    const out = JSON.parse(await builds({ action: "get", buildId: SHA, api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.artifacts).toEqual([]);
    expect(out.value.integrity).toEqual({});
    expect(calls).toContain(`${BUILD_ROUTE}/artifacts`);
    expect(calls).toContain(`${BUILD_ROUTE}/integrity/chrome`);

    expect(out.warnings).toEqual([
      `The artifact list for build ${SHA} is missing (404).`,
      `Integrity for build ${SHA} could not be read: chrome is a 200 without a JSON body; firefox is missing (404).`,
    ]);

    expect(out.hint).not.toContain("arrive when the build finishes");
    expect(out.warnings.join(" ")).not.toMatch(/https?:\/\/|\/api\//);
  });
});
