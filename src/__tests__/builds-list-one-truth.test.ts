import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { buildState, isoSeconds } from "../lib/builds-list-row";
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

const RUN_ONLY = {
  id: "dcd8a23",
  buildId: "dcd8a23",
  commit: "dcd8a23a27384f391e4b2fdf1b0e411028f83811",
  status: "building",
  branch: "main",
  timestamp: "2026-10-30T17:37:34.000Z",
  startedAt: "2026-10-30T17:37:34.000Z",
  deploymentId: "5ce983b81fb8228558e25ad2e20249ed3bd908d6",
  duration: "9m 52s",
  browsers: [],
  runId: 7002,
};

const ONE_STAMP = {
  id: "f939a95",
  buildId: "f939a95",
  commit: "f939a958d6cb31060d610877db9b612704952573",
  status: "success",
  buildEnv: "staging",
  channel: "preview",
  timestamp: "2026-10-30T17:45:22Z",
  startedAt: "2026-10-30T17:45:22Z",
  completedAt: "2026-10-30T17:45:22Z",
  duration: "0m 34s",
  summaryStatus: "success",
  browsers: ["chrome", "firefox", "edge"],
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
    expect(row.startedAt).toBe("2026-10-30T17:32:33Z");
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
      startedAt: "2026-10-11T16:44:31Z",
      completedAt: "2026-10-11T16:45:37Z",
      duration: "1m 6s",
    });

    expect(row.runningFor).toBeUndefined();
    expect(row.timestamp).toBeUndefined();
    expect(out.hint).toContain("the latest is 603fc8a (success)");
  });

  it("a running row with no browsers says the platform has not reported them, and a finished one does not", async () => {
    if (process.platform === "win32") return;

    body = { items: [RUN_ONLY, { ...TWO_STAMPS, browsers: [] }] };
    const out = await list();
    const [running, finished] = out.value.builds;

    expect(running.browsers).toEqual([]);
    expect(running.browsersNote).toContain("has not reported this run's browsers yet");
    expect(finished.browsersNote).toBeUndefined();
    expect(out.hint).toContain("dcd8a23 (building for 9m 52s) has no browser reported by the platform yet");
  });

  it("answers the platform's one timestamp as timestamp, never as a start and an end", async () => {
    if (process.platform === "win32") return;

    body = { items: [ONE_STAMP] };
    const out = await list();
    const row = out.value.builds[0];

    expect(row.timestamp).toBe("2026-10-30T17:45:22Z");
    expect(row.startedAt).toBeUndefined();
    expect(row.completedAt).toBeUndefined();
    expect(row.createdAt).toBeUndefined();
    expect(row.duration).toBe("0m 34s");
    expect(out.warnings).toContain(
      "The platform recorded one timestamp for build f939a95, not a start and an end; it is answered as timestamp beside the duration the platform reported.",
    );
  });

  it("writes every timestamp in one format, seconds in UTC, and invents no createdAt", async () => {
    if (process.platform === "win32") return;

    expect(isoSeconds("2026-10-30T17:40:06.690Z")).toBe("2026-10-30T17:40:06Z");
    expect(isoSeconds("2026-10-30T17:33:42Z")).toBe("2026-10-30T17:33:42Z");
    expect(isoSeconds("")).toBe("");
    expect(isoSeconds("not a date")).toBe("not a date");

    body = {
      items: [TWO_STAMPS],
      lastPush: { commit: "4478aff", ref: "main", receivedAt: "2026-10-24T23:50:33.690Z", outcome: "DISPATCHED", dispatched: true },
      headLag: {
        branch: "main",
        headCommit: "4478aff",
        lastBuildId: "603fc8a",
        lastBuildAt: "2026-10-11T16:45:37.000Z",
        reason: "build_not_started",
        pushReceivedAt: "2026-10-24T23:50:33.690Z",
        restarting: false,
        message: "main is at 4478aff, last build 603fc8a, no build started for it.",
      },
    };

    const out = await list();

    expect(out.value.builds[0].createdAt).toBeUndefined();
    expect(out.value.lastPush.receivedAt).toBe("2026-10-24T23:50:33Z");
    expect(out.value.headLag).toMatchObject({ lastBuildAt: "2026-10-11T16:45:37Z", pushReceivedAt: "2026-10-24T23:50:33Z" });
    expect(out.value.lastPush.build).toBeUndefined();
    expect(out.hint).not.toContain("The last push");
  });

  it("a debounced push that a listed build carries names that row and says the push record is older", async () => {
    if (process.platform === "win32") return;

    body = {
      items: [RUN_ONLY, ONE_STAMP],
      lastPush: { commit: "f939a95", ref: "main", receivedAt: "2026-10-30T17:40:06.690Z", outcome: "DEBOUNCED", dispatched: false },
    };

    const out = await list();

    expect(out.value.lastPush).toMatchObject({
      commit: "f939a95",
      outcome: "DEBOUNCED",
      dispatched: false,
      receivedAt: "2026-10-30T17:40:06Z",
      build: { buildId: "f939a95", status: "success" },
    });

    expect(out.hint).toContain(
      "The last push f939a95 (received 2026-10-30T17:40:06Z) was debounced: the platform queued it and then built it, so row f939a95 reads success; the push record keeps the outcome it had when the push arrived.",
    );
  });

  it("a debounced push with no build row says it folds into the branch's next dispatched build", async () => {
    if (process.platform === "win32") return;

    body = {
      items: [TWO_STAMPS],
      lastPush: { commit: "f939a95", ref: "main", receivedAt: "2026-10-30T17:40:06Z", outcome: "DEBOUNCED", dispatched: false },
    };

    const out = await list();

    expect(out.value.lastPush.build).toBeUndefined();
    expect(out.hint).toContain(
      "The last push f939a95 (received 2026-10-30T17:40:06Z) was debounced: the platform queued it and it folds into the next build it dispatches for main; no build row carries it yet.",
    );
  });

  it("a refused push gets no folding sentence", async () => {
    if (process.platform === "win32") return;

    body = {
      items: [TWO_STAMPS],
      lastPush: { commit: "f939a95", ref: "main", receivedAt: "2026-10-30T17:40:06Z", outcome: "PUSH_BUILDS_EXHAUSTED", dispatched: false },
    };

    const out = await list();

    expect(out.hint).not.toContain("The last push");
  });
});
