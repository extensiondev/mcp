import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { buildState } from "../lib/builds-list-row";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_hands";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const RUNNING_WITH_VERDICT = {
  id: "154767e",
  buildId: "154767e",
  commit: "154767e96aca6864db7db35d00154940807560e1",
  status: "building",
  buildEnv: "staging",
  channel: "preview",
  timestamp: "2026-10-30T17:32:33.000Z",
  startedAt: "2026-10-30T17:32:33.000Z",
  completedAt: "2026-10-30T17:36:17.000Z",
  duration: "3m 44s",
  summaryStatus: "success",
  conclusion: "success",
  browsers: ["chrome", "firefox", "edge"],
  runId: 7001,
};

const TWO_STAMPS = {
  id: "603fc8a",
  buildId: "603fc8a",
  commit: "603fc8ab0ff0ac1dae1c598428ce49ad43081c98",
  status: "completed",
  conclusion: "success",
  startedAt: "2026-10-11T16:44:31.000Z",
  completedAt: "2026-10-11T16:45:37.000Z",
  duration: "1m 6s",
  browsers: ["chrome"],
};

describe("extension_builds answers one truth per build", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;
  let body: Record<string, unknown>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-truth-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    body = { items: [] };

    global.fetch = (async (url: string) => {
      const pathname = new URL(String(url)).pathname;

      if (pathname === "/api/cli/whoami") {
        return jsonResponse({ login: "acme/hands", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "hands" });
      }

      if (pathname === `/api/projects/${PROJECT_ID}/builds`) return jsonResponse(body);

      return jsonResponse({ message: "not found" }, 404);
    }) as unknown as typeof fetch;

    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "hands",
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

  async function list() {
    const out = JSON.parse(await builds({ action: "list", api: API }));
    expect(out.ok).toBe(true);

    return out;
  }

  it("maps the platform's status and conclusion words to one state word", () => {
    expect(buildState("completed", "success")).toBe("success");
    expect(buildState("completed", "failure")).toBe("failed");
    expect(buildState("completed", "cancelled")).toBe("cancelled");
    expect(buildState("completed", "timed_out")).toBe("failed");
    expect(buildState("in_progress")).toBe("building");
    expect(buildState("running")).toBe("building");
    expect(buildState("queued")).toBe("pending");
    expect(buildState("ready")).toBe("success");
    expect(buildState("error")).toBe("failed");
    expect(buildState("canceled")).toBe("cancelled");
    expect(buildState("", "success")).toBe("success");
  });

  it("a running build carries no verdict, no completion and no duration, only how long it has run", async () => {
    if (process.platform === "win32") return;

    body = { items: [RUNNING_WITH_VERDICT] };
    const out = await list();
    const row = out.value.builds[0];

    expect(row.status).toBe("building");
    expect(row.conclusion).toBeUndefined();
    expect(row.completedAt).toBeUndefined();
    expect(row.duration).toBeUndefined();
    expect(row.runningFor).toBe("3m 44s");
    expect(row.startedAt).toBe("2026-10-30T17:32:33.000Z");
    expect(out.hint).toContain("the latest is 154767e (building)");
  });

  it("a finished build says so in status and in the hint, with its verdict beside it", async () => {
    if (process.platform === "win32") return;

    body = { items: [TWO_STAMPS] };
    const out = await list();
    const row = out.value.builds[0];

    expect(row).toMatchObject({
      status: "success",
      conclusion: "success",
      startedAt: "2026-10-11T16:44:31.000Z",
      completedAt: "2026-10-11T16:45:37.000Z",
      duration: "1m 6s",
    });

    expect(row.runningFor).toBeUndefined();
    expect(row.timestamp).toBeUndefined();
    expect(out.hint).toContain("the latest is 603fc8a (success)");
  });
});
