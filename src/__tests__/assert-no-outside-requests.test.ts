import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readyContractPath } from "../lib/session-paths";

import type { NetworkWatchReading, SeenRequest, WatchedTarget } from "../lib/network-watch";

const GUEST_ID = "abcdefghijklmnopabcdefghijklmnop";

type Target = { id: string; type: string; url: string; title?: string };

const live = vi.hoisted(() => ({
  targets: [] as Target[],
  port: 9222 as number | null,
  reading: null as NetworkWatchReading | null,
  watchError: null as string | null,
  watchCalls: [] as Array<{ durationMs: number }>,
  connected: 0,
}));

vi.mock("../lib/cdp", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeCdp {
    static async discoverTargets() {
      return live.targets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/fake";
    }
    async connect() {
      live.connected += 1;
    }
    async attachToTarget(id: string) {
      return `session-${id}`;
    }
    async enableDomains() {}
    disconnect() {}
  }

  return { ...actual, CDPClient: FakeCdp };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return {
    ...actual,
    resolveCdpPort: async () => (live.port === null ? null : { port: live.port }),
  };
});

vi.mock("../lib/network-watch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return {
    ...actual,
    watchNetwork: async (_connection: unknown, options: { durationMs: number }) => {
      live.watchCalls.push(options);
      if (live.watchError) throw new Error(live.watchError);

      return live.reading;
    },
  };
});

const { handler } = await import("../tools/assert");

const BROWSER = "chrome";

let project: string;

function liveSession(): void {
  const manifest = path.join(project, "dist", BROWSER, "manifest.json");
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ manifest_version: 3, background: { service_worker: "sw.js" } }));

  const file = readyContractPath(project, BROWSER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      status: "ready",
      pid: process.pid,
      runId: "run-1",
      instanceId: "inst-1",
      distPath: path.join(project, "dist", BROWSER),
      extensionId: GUEST_ID,
      cdpPort: 9222,
    }),
  );

  live.targets = [{ id: "sw", type: "service_worker", url: `chrome-extension://${GUEST_ID}/sw.js` }];
}

function watched(type: string, url: string, detached = false): WatchedTarget {
  return { sessionId: `s-${type}-${url}`, targetId: `t-${url}`, type, url, detached };
}

function seen(target: { type: string; url: string }, url: string, initiators: string[] = []): SeenRequest {
  return { url, method: "GET", kind: "request", target, initiators, at: 3 };
}

const SW = { type: "service_worker", url: `chrome-extension://${GUEST_ID}/sw.js` };
const OFFSCREEN = { type: "page", url: `chrome-extension://${GUEST_ID}/offscreen.html` };
const WORKER = { type: "worker", url: `chrome-extension://${GUEST_ID}/decoder.js` };
const YOUTUBE = { type: "page", url: "https://www.youtube.com/watch?v=x" };

function reading(attached: WatchedTarget[], requests: SeenRequest[], enableErrors: string[] = []): NetworkWatchReading {
  return { durationMs: 5000, attached, requests, enableErrors };
}

async function assertOnce(clause: Record<string, unknown>, browser = BROWSER) {
  const raw = await handler({ projectPath: project, browser, expect: [clause] });
  const frame = JSON.parse(raw);

  return { frame, check: frame.value?.checks?.[0] };
}

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-assert-net-"));
  live.targets = [];
  live.port = 9222;
  live.reading = null;
  live.watchError = null;
  live.watchCalls = [];
  live.connected = 0;
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe("no-outside-requests", () => {
  it("is a declared check whose clause defaults to a five second watch and normalizes the allowed hosts", async () => {
    liveSession();
    live.reading = reading([watched("service_worker", SW.url)], []);

    const { frame, check } = await assertOnce({ assert: "no-outside-requests", allow: ["https://*.Example.com/x", "api.example.com"] });

    expect(frame.ok).toBe(true);
    expect(check.id).toBe("no-outside-requests");
    expect(check.subject).toBe("example.com,api.example.com");
    expect(live.watchCalls).toEqual([{ durationMs: 5000 }]);
  });

  it.each([
    [{ assert: "no-outside-requests", allow: [""] }, "allow holds"],
    [{ assert: "no-outside-requests", allow: [42] }, "allow holds"],
    [{ assert: "no-outside-requests", durationMs: 10 }, "durationMs must be"],
    [{ assert: "no-outside-requests", durationMs: 600000 }, "durationMs must be"],
  ])("refuses the clause %j before touching the browser", async (clause, issue) => {
    liveSession();

    const { frame } = await assertOnce(clause);

    expect(frame.status).toBe("bad-request");
    expect(frame.error.message).toContain(issue);
    expect(live.watchCalls).toEqual([]);
  });

  it("fails on a request that left the machine, naming the url, the context that sent it and the script that started it", async () => {
    liveSession();
    live.reading = reading(
      [watched("service_worker", SW.url), watched("page", OFFSCREEN.url), watched("worker", WORKER.url), watched("page", YOUTUBE.url)],
      [
        seen(WORKER, "https://collector.example.com/frames", [`chrome-extension://${GUEST_ID}/decoder.js`]),
        seen(YOUTUBE, "https://telemetry.example.com/ping", [`chrome-extension://${GUEST_ID}/content.js`]),
        seen(YOUTUBE, "https://i.ytimg.com/vi/x/hq.jpg"),
        seen(SW, `chrome-extension://${GUEST_ID}/model.json`),
      ],
    );

    const { frame, check } = await assertOnce({ assert: "no-outside-requests" });

    expect(frame.ok).toBe(false);
    expect(check.outcome).toBe("fail");
    expect(check.detail).toContain("2 request(s) left the machine");
    expect(check.detail).toContain(`GET https://collector.example.com/frames from worker chrome-extension://${GUEST_ID}/decoder.js`);
    expect(check.detail).toContain(
      `GET https://telemetry.example.com/ping from page https://www.youtube.com/watch?v=x (initiated by chrome-extension://${GUEST_ID}/content.js)`,
    );

    expect(check.evidence.outside.map((row: { url: string }) => row.url)).toEqual([
      "https://collector.example.com/frames",
      "https://telemetry.example.com/ping",
    ]);

    expect(check.evidence.foreign).toBe(1);
    expect(check.evidence.watched).toHaveLength(3);
  });

  it("passes when every request of the extension stayed on the machine or went to an allowed host, and says what it watched", async () => {
    liveSession();
    live.reading = reading(
      [watched("service_worker", SW.url), watched("page", OFFSCREEN.url), watched("worker", WORKER.url)],
      [
        seen(SW, `chrome-extension://${GUEST_ID}/model.json`),
        { ...seen(SW, "ws://127.0.0.1:8081/reload"), method: "WS", kind: "websocket" },
        seen(WORKER, "https://cdn.models.example.com/weights.bin"),
      ],
    );

    const { frame, check } = await assertOnce({ assert: "no-outside-requests", allow: ["models.example.com"] });

    expect(frame.ok).toBe(true);
    expect(check.outcome).toBe("pass");
    expect(check.detail).toContain("3 context(s) of the extension (1 page, 1 service_worker, 1 worker)");
    expect(check.detail).toContain("3 request(s) seen, 2 to the extension itself, loopback or data URLs and 1 to the allowed host(s) models.example.com");
    expect(check.detail).toContain("Requests before the watch began were not observed");
    expect(check.evidence.requests).toHaveLength(3);
  });

  it("does not pass when no context of the extension was alive during the watch", async () => {
    liveSession();
    live.reading = reading([watched("page", YOUTUBE.url)], [seen(YOUTUBE, "https://i.ytimg.com/vi/x/hq.jpg")]);

    const { frame, check } = await assertOnce({ assert: "no-outside-requests" });

    expect(frame.ok).toBe(false);
    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toContain("No context of the extension");
    expect(check.detail).toContain("none of them the extension's");
    expect(check.settledBy).toContain("extension_open");
  });

  it("does not pass when a watched target refused network events, because a request from it would not have been seen", async () => {
    liveSession();
    live.reading = reading([watched("service_worker", SW.url), watched("worker", WORKER.url)], [], [
      `worker ${WORKER.url}: Network domain is not supported on this target`,
    ]);

    const { check } = await assertOnce({ assert: "no-outside-requests" });

    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toContain("1 attached target(s) refused network events");
    expect(check.evidence.enableErrors).toHaveLength(1);
  });

  it("still fails on a request that left the machine even when another target refused network events", async () => {
    liveSession();
    live.reading = reading(
      [watched("service_worker", SW.url), watched("worker", WORKER.url)],
      [seen(SW, "https://api.example.com/sync")],
      [`worker ${WORKER.url}: refused`],
    );

    const { check } = await assertOnce({ assert: "no-outside-requests" });

    expect(check.outcome).toBe("fail");
  });

  it("is inconclusive when the browser refuses the watch before it starts", async () => {
    liveSession();
    live.watchError = "CDP WebSocket is not connected";

    const { check } = await assertOnce({ assert: "no-outside-requests" });

    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toContain("refused the watch before it started (CDP WebSocket is not connected)");
  });

  it("is inconclusive with no debug port, and on Firefox, without opening a connection", async () => {
    liveSession();
    live.port = null;

    const noPort = await assertOnce({ assert: "no-outside-requests" });
    expect(noPort.check.outcome).toBe("inconclusive");
    expect(noPort.check.detail).toContain("No session with a debugging port");

    live.port = 9222;
    const firefox = await assertOnce({ assert: "no-outside-requests" }, "firefox");
    expect(firefox.check.outcome).toBe("inconclusive");
    expect(firefox.check.detail).toContain("Chrome DevTools Protocol");
    expect(firefox.check.settledBy).toContain("Chromium");
    expect(live.watchCalls).toEqual([]);
    expect(live.connected).toBe(0);
  });

  it("refuses the same watch stated twice in one stage", async () => {
    liveSession();

    const raw = await handler({
      projectPath: project,
      browser: BROWSER,
      expect: [{ assert: "no-outside-requests" }, { assert: "no-outside-requests", durationMs: 1000 }],
    });
    const frame = JSON.parse(raw);

    expect(frame.status).toBe("bad-request");
    expect(frame.error.message).toContain("no-outside-requests is asserted more than once");
  });
});
