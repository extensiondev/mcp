import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { writeCredentials } from "../lib/credentials";
import { attachTrack } from "../lib/track-url";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
const DISPATCH_ROUTE = `/api/projects/${PROJECT_ID}/builds/dispatch`;
const BUILD_ROUTE = `/api/projects/${PROJECT_ID}/builds/4478aff`;

type Reply = { body: unknown; status?: number };
type Call = { url: string; method: string };

function reply({ body, status = 200 }: Reply): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function running(details: Record<string, unknown>): Reply {
  return {
    body: {
      code: "BUILD_ALREADY_RUNNING",
      message: "Commit 4478aff on main is already building, so no rebuild was started and nothing was spent.",
      trackUrl: "https://console.extension.dev/acme/widget/builds/4478aff",
      details: { branch: "main", commit: "4478aff", buildId: "4478aff", dispatched: false, ...details },
    },
    status: 409,
  };
}

describe("extension_builds rebuild of a commit whose build is already running", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;
  let calls: Call[];
  let routes: Record<string, () => Reply>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-running-"));
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
    };

    global.fetch = (async (url: string, init?: RequestInit) => {
      const method = String(init?.method ?? "GET").toUpperCase();
      calls.push({ url: String(url), method });
      const route = routes[`${method} ${new URL(String(url)).pathname}`];

      return reply(route ? route() : { body: { message: "not found" }, status: 404 });
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

  it("follows that build, dispatches nothing and never names where it runs", async () => {
    if (process.platform === "win32") return;

    routes[`POST ${DISPATCH_ROUTE}`] = () => running({ state: "in_progress", startedAt: "2026-10-24T23:51:05.000Z", deploymentId: "d-aaaa1111" });
    routes[`GET ${BUILD_ROUTE}`] = () => ({ body: { buildId: "4478aff", status: "in_progress", startedAt: "2026-10-24T23:51:05.000Z" } });

    const args = { action: "rebuild", buildId: "4478aff", waitSeconds: 0, api: API };
    const out = JSON.parse(attachTrack("extension_builds", args, await builds(args)));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("build-already-running");
    expect(out.value).toMatchObject({ action: "rebuild", commit: "4478aff", branch: "main", dispatched: false, running: { state: "in_progress", deploymentId: "d-aaaa1111" } });
    expect(out.value.outcome).toMatchObject({ recorded: false, status: "in_progress", source: "platform-record" });
    expect(out.value.links.map((link: { kind: string }) => link.kind)).toEqual(["build"]);
    expect(String(out.value.trackUrl)).toMatch(/\/acme\/widget\/.*4478aff/);
    expect(out.hint).toContain("Nothing was dispatched and nothing was spent");
    expect(out.hint).toContain("would cancel it");
    expect(JSON.stringify(out)).not.toMatch(/actions\/runs|extension-user-land|mirror/i);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("answers the record once that build has finished", async () => {
    if (process.platform === "win32") return;

    routes[`POST ${DISPATCH_ROUTE}`] = () => running({ state: "queued", startedAt: null });
    routes[`GET ${BUILD_ROUTE}`] = () => ({ body: { buildId: "4478aff", status: "success" } });

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "4478aff", waitSeconds: 0, api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("built");
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "success" });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("names a failed build as failed once the build it found has finished red", async () => {
    if (process.platform === "win32") return;

    routes[`POST ${DISPATCH_ROUTE}`] = () => running({ state: "in_progress", startedAt: "2026-10-24T23:51:05.000Z" });
    routes[`GET ${BUILD_ROUTE}`] = () => ({ body: { buildId: "4478aff", status: "failed" } });

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "4478aff", waitSeconds: 0, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("build-failed");
    expect(out.hint).toContain('action:"logs"');
  });
});
