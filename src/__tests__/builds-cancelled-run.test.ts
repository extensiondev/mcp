import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
const RUN_URL = "https://console.extension.dev/acme/widget/builds/d8044e3";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const CANCELLED_ROW = {
  id: "d8044e3c1f0b9a8e7d6c5b4a3928170605040302",
  buildId: "d8044e3",
  commit: "d8044e3c1f0b9a8e7d6c5b4a3928170605040302",
  status: "cancelled",
  supersededBy: "9081f4d",
  branch: "main",
  timestamp: "2026-10-23T15:01:12Z",
  duration: "4m 0s",
  browsers: [],
};

const NEWER_ROW = {
  id: "9081f4d2e1d0c9b8a7f6e5d4c3b2a19080706050",
  buildId: "9081f4d",
  commit: "9081f4d2e1d0c9b8a7f6e5d4c3b2a19080706050",
  status: "success",
  branch: "main",
  timestamp: "2026-10-23T15:03:40Z",
  browsers: ["chrome", "edge", "firefox"],
};

const FAILED_ROW = {
  id: "5a5a5a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f",
  buildId: "5a5a5a5",
  commit: "5a5a5a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f",
  status: "failed",
  branch: "main",
  timestamp: "2026-10-23T13:04:00Z",
  browsers: [],
};

const CANCELLED_ITEMS = ["chrome", "edge", "firefox"].map((browser) => ({
  browser,
  status: "cancelled",
  issueKind: "info",
  runUrl: RUN_URL,
  reason: "the run was canceled before this browser's job started",
  logs: [],
}));

const CANCELLED_LOGS = {
  buildId: "d8044e3",
  runUrl: RUN_URL,
  runUrlAvailable: true,
  run: {
    status: "completed",
    conclusion: "cancelled",
    failedJob: null,
    supersededBy: "9081f4d",
    source: "run",
    note: "The platform canceled this run because 9081f4d landed on the same branch; nothing is wrong with this build.",
  },
  items: CANCELLED_ITEMS,
};

describe("extension_builds reads a run the platform cancelled as cancelled", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;
  let prevApi: string | undefined;
  let routes: Record<string, { body: unknown; status?: number }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-cancelled-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    routes = {
      "/api/cli/whoami": {
        body: { login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" },
      },
      [`/api/projects/${PROJECT_ID}/builds`]: { body: { items: [NEWER_ROW, CANCELLED_ROW, FAILED_ROW] } },
      [`/api/projects/${PROJECT_ID}/builds/d8044e3/logs`]: { body: CANCELLED_LOGS },
    };

    global.fetch = (async (url: string) => {
      const route = routes[new URL(String(url)).pathname];

      return route ? jsonResponse(route.body, route.status ?? 200) : jsonResponse({ message: "not found" }, 404);
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

  it("lists the cancelled build as cancelled with the commit that superseded it", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await builds({ action: "list", api: API }));
    const byId = Object.fromEntries(out.value.builds.map((row: { buildId: string }) => [row.buildId, row]));

    expect(byId.d8044e3).toMatchObject({ status: "cancelled", supersededBy: "9081f4d", browsers: [] });
    expect(byId["9081f4d"].supersededBy).toBeUndefined();
    expect(byId["5a5a5a5"]).toMatchObject({ status: "failed" });
    expect(byId["5a5a5a5"].supersededBy).toBeUndefined();
    expect(out.value.sayToPerson).toBe("Build d8044e3 was canceled because 9081f4d landed; nothing is wrong with it.");
    expect(out.hint).toContain("Build d8044e3 was canceled because 9081f4d landed; nothing is wrong with it.");
    expect(out.value.trackUrl).toContain("/acme/widget/builds");
  });

  it("answers supersededBy null when the platform named no newer commit", async () => {
    if (process.platform === "win32") return;

    routes[`/api/projects/${PROJECT_ID}/builds`] = { body: { items: [{ ...CANCELLED_ROW, supersededBy: null }] } };

    const out = JSON.parse(await builds({ action: "list", api: API }));

    expect(out.value.builds[0]).toMatchObject({ status: "cancelled", supersededBy: null });
    expect(out.value.sayToPerson).toBe("Build d8044e3 was canceled by the platform; nothing is wrong with it.");
  });

  it("passes the cancelled run and supersededBy through the logs answer, with no browser called failed", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await builds({ action: "logs", buildId: "d8044e3", api: API }));

    expect(out.value.run).toMatchObject({ status: "completed", conclusion: "cancelled", supersededBy: "9081f4d", failedJob: null });
    expect(out.value.items.map((item: { status: string }) => item.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(out.value.items[0].reason).toBe("the run was canceled before this browser's job started");
    expect(out.value.sayToPerson).toBe("Build d8044e3 was canceled because 9081f4d landed; nothing is wrong with it.");
    expect(out.hint.startsWith("Build d8044e3 was canceled because 9081f4d landed; nothing is wrong with it.")).toBe(true);
    expect(out.value.trackUrl).toContain("/builds/d8044e3");
    expect(JSON.stringify(out)).not.toContain("failed before");
  });

  it("settles a pending browser under a cancelled run as cancelled, not skipped", async () => {
    if (process.platform === "win32") return;

    routes[`/api/projects/${PROJECT_ID}/builds/d8044e3/logs`] = {
      body: { ...CANCELLED_LOGS, items: CANCELLED_ITEMS.map((item) => ({ ...item, status: "pending", reason: undefined })) },
    };

    const out = JSON.parse(await builds({ action: "logs", buildId: "d8044e3", api: API }));

    expect(out.value.items.map((item: { status: string }) => item.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(out.value.items[1].reason).toBe("the run was canceled before this browser's job started");
    expect(JSON.stringify(out)).not.toContain('"skipped"');
  });
});
