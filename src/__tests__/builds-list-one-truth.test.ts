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
  let dispatchBody: Record<string, unknown>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-truth-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    body = { items: [] };
    dispatchBody = { ok: true, branch: "main", commit: "4cec881", browsers: "chrome", dispatchedAt: "2026-11-11T16:52:04.000Z" };

    global.fetch = (async (url: string) => {
      const pathname = new URL(String(url)).pathname;

      if (pathname === "/api/cli/whoami") {
        return jsonResponse({ login: "acme/hands", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "hands" });
      }

      if (pathname === `/api/projects/${PROJECT_ID}/builds`) return jsonResponse(body);
      if (pathname === `/api/projects/${PROJECT_ID}/builds/dispatch`) return jsonResponse(dispatchBody);

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

  it("ledger 343: never answers a finished row's lone record stamp as the start its building read gave", async () => {
    if (process.platform === "win32") return;

    const building = { id: "982a348", buildId: "982a348", commit: "982a348e1f0c2b3a4d5e6f708192a3b4c5d6e7f8", status: "building", startedAt: "2026-10-31T23:12:06Z", timestamp: "2026-10-31T23:12:06Z", runId: 7003 };
    body = { items: [building] };
    const before = (await list()).value.builds[0];

    body = { items: [{ ...building, status: "success", summaryStatus: "success", startedAt: undefined, timestamp: "2026-10-31T23:16:00Z", duration: "4m 57s" }] };
    const after = (await list()).value.builds[0];

    expect(before.startedAt).toBe("2026-10-31T23:12:06Z");
    expect(after.startedAt).toBeUndefined();
    expect(after.timestamp).toBe("2026-10-31T23:16:00Z");
    expect(after.duration).toBe("4m 57s");
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

  it("ledger 498: an empty list with no push record says the import produced no first build and names rebuild, never a push", async () => {
    if (process.platform === "win32") return;

    body = { items: [] };
    dispatchBody = { ok: true, branch: "main", commit: "4cec881", browsers: "chrome", dispatchedAt: "2026-11-11T16:52:04.000Z" };

    const out = await list();

    expect(out.value.builds).toEqual([]);
    expect(out.value.lastPush).toBeUndefined();
    expect(out.hint).toContain("has produced no build yet");
    expect(out.hint).toContain('extension_builds action:"rebuild"');
    expect(out.hint).not.toContain("Push a commit");
  });

  it("ledger 540: an empty list with no push record never says the source was imported or names a branch head, and names rebuild of the stored tree", async () => {
    if (process.platform === "win32") return;

    body = { items: [] };

    const out = await list();

    expect(out.value.builds).toEqual([]);
    expect(out.hint).not.toMatch(/import produced|build the branch head|was pushed|pushed and/);
    expect(out.hint).toContain("an upload (no repository, nothing to push)");
    expect(out.hint).toContain('extension_builds action:"rebuild"');
    expect(out.hint).toContain("stored tree");
  });

  it("ledger 498: an empty list with a push record keeps the push sentence and still names rebuild", async () => {
    if (process.platform === "win32") return;

    body = {
      items: [],
      lastPush: { commit: "f939a95", ref: "main", receivedAt: "2026-10-30T17:40:06Z", outcome: "DEBOUNCED", dispatched: false },
    };

    const out = await list();

    expect(out.hint).toContain("The last push f939a95");
    expect(out.hint).not.toContain("produced no first build");
    expect(out.hint).toContain('extension_builds action:"rebuild"');
    expect(out.hint).not.toContain("Push a commit");
  });

  it("ledger 507: an empty list right after this server dispatched a build says the build is dispatched, not recorded yet, and names get for that sha", async () => {
    if (process.platform === "win32") return;

    body = { items: [] };
    const dispatched = JSON.parse(await builds({ action: "rebuild", buildId: "4cec881", waitSeconds: 0, api: API }));

    expect(dispatched.status).toBe("rebuild-dispatched");

    const out = await list();

    expect(out.value.builds).toEqual([]);
    expect(out.value.dispatched).toEqual({ buildId: "4cec881", dispatchedAt: "2026-11-11T16:52:04Z" });
    expect(out.hint).toContain("Build for 4cec881 was dispatched at 2026-11-11T16:52:04Z, not recorded yet");
    expect(out.hint).toContain('extension_builds action:"get" with buildId 4cec881');
    expect(out.hint).not.toContain('action:"rebuild"');
    expect(out.hint).not.toContain("Push a commit");
    expect(out.hint).not.toContain("produced no first build");
  });

  it("ledger 507: once the list carries the dispatched build, the dispatch sentence is gone", async () => {
    if (process.platform === "win32") return;

    body = { items: [{ ...TWO_STAMPS, id: "4cec881", buildId: "4cec881", commit: "4cec8810ff0ac1dae1c598428ce49ad43081c98", status: "building", conclusion: undefined, completedAt: undefined, duration: undefined }] };

    const out = await list();

    expect(out.value.dispatched).toBeUndefined();
    expect(out.hint).not.toContain("not recorded yet");
    expect(out.hint).toContain("the latest is 4cec881 (building)");

    body = { items: [] };
    const after = await list();

    expect(after.value.dispatched).toBeUndefined();
    expect(after.hint).toContain('extension_builds action:"rebuild"');
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

  it("ledger 357: a build newer than the push record marks lastPush stale and names that build", async () => {
    if (process.platform === "win32") return;

    const pending = { id: "6b393ca", buildId: "6b393ca", commit: "6b393ca0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70", status: "pending", startedAt: "2026-11-01T00:17:35Z", timestamp: "2026-11-01T00:17:35Z", runId: 7010 };
    const previous = { id: "982a348", buildId: "982a348", commit: "982a348e1f0c2b3a4d5e6f708192a3b4c5d6e7f8", status: "success", summaryStatus: "success", timestamp: "2026-10-31T23:16:00Z", duration: "4m 57s" };
    body = {
      items: [pending, previous],
      lastPush: { commit: "982a348", ref: "main", receivedAt: "2026-10-31T23:12:02.120Z", outcome: "DISPATCHED", dispatched: true },
    };

    const out = await list();

    expect(out.value.lastPush).toMatchObject({
      commit: "982a348",
      stale: true,
      newerBuild: { buildId: "6b393ca", status: "pending", startedAt: "2026-11-01T00:17:35Z" },
      build: { buildId: "982a348", status: "success" },
    });

    expect(out.hint).toContain(
      "lastPush is stale: it still names 982a348 (received 2026-10-31T23:12:02Z), while build 6b393ca (pending) started at 2026-11-01T00:17:35Z, after that record; the platform has not recorded the push behind 6b393ca yet, so builds[0] is the newest build.",
    );
  });

  it("ledger 357: the platform's own newerBuild mark is answered as stale, and a push newer than every row is not", async () => {
    if (process.platform === "win32") return;

    body = {
      items: [TWO_STAMPS],
      lastPush: { commit: "982a348", ref: "main", receivedAt: "2026-10-31T23:12:02Z", outcome: "DISPATCHED", dispatched: true, stale: true, newerBuild: { buildId: "6b393ca", status: "building", startedAt: "2026-11-01T00:17:35.000Z" } },
    };

    const marked = await list();

    expect(marked.value.lastPush).toMatchObject({ stale: true, newerBuild: { buildId: "6b393ca", startedAt: "2026-11-01T00:17:35Z" } });
    expect(marked.hint).toContain("lastPush is stale: it still names 982a348");

    body = {
      items: [TWO_STAMPS],
      lastPush: { commit: "4478aff", ref: "main", receivedAt: "2026-10-24T23:50:33Z", outcome: "DISPATCHED", dispatched: true },
    };

    const fresh = await list();

    body = {
      items: [{ ...TWO_STAMPS, startedAt: undefined, completedAt: undefined, timestamp: "2026-10-25T00:10:00Z" }],
      lastPush: { commit: "4478aff", ref: "main", receivedAt: "2026-10-24T23:50:33Z", outcome: "DISPATCHED", dispatched: true },
    };

    const endedAfter = await list();

    expect(endedAfter.value.lastPush.stale).toBeUndefined();
    expect(fresh.value.lastPush.stale).toBeUndefined();
    expect(fresh.value.lastPush.newerBuild).toBeUndefined();
    expect(fresh.hint).not.toContain("stale");
  });

  it("ledger 465: relays the pins holding a build as channels and never answers a channel field", async () => {
    body = { items: [{ ...ONE_STAMP, buildEnv: "production", channels: [{ channel: "stable", browsers: ["firefox"] }] }] };

    const out = await list();
    const row = out.value.builds[0];

    expect(row.channels).toEqual([{ channel: "stable", browsers: ["firefox"] }]);
    expect(row.env).toBe("production");
    expect(row).not.toHaveProperty("channel");
    expect(out.hint).toContain("held by stable for firefox");
  });

  it("ledger 465: an empty channels list says no pin holds the build", async () => {
    body = { items: [{ ...ONE_STAMP, channels: [] }] };

    const out = await list();

    expect(out.value.builds[0].channels).toEqual([]);
    expect(out.hint).toContain("held by no pin");
  });

  it("ledger 465: a row without channels answers neither channels nor channel, and a legacy channel is never a pin", async () => {
    body = { items: [ONE_STAMP, TWO_STAMPS] };

    const out = await list();

    for (const row of out.value.builds) {
      expect(row).not.toHaveProperty("channels");
      expect(row).not.toHaveProperty("channel");
    }

    expect(out.value.builds[0].env).toBe("staging");
    expect(out.hint).not.toContain("preview");
    expect(out.hint).not.toContain("held by");
  });
});
