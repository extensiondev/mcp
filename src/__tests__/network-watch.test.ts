import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  classifyRequests,
  extensionTargets,
  hostAllowed,
  isOnMachine,
  normalizeAllowHost,
  targetCensus,
  watchNetwork,
  type SeenRequest,
  type WatchedTarget,
} from "../lib/network-watch";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const OTHER = "ponmlkjihgfedcbaponmlkjihgfedcba";

interface FakeTarget {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  waitingForDebugger?: boolean;
}

type Call = { method: string; params: Record<string, unknown>; sessionId?: string };

class FakeConnection {
  calls: Call[] = [];
  refuseNetworkOn = new Set<string>();
  private listeners = new Set<(msg: Record<string, unknown>) => void>();

  constructor(
    private readonly top: FakeTarget[],
    private readonly nested: Record<string, FakeTarget[]> = {},
  ) {}

  async sendCommand(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    this.calls.push({ method, params, ...(sessionId ? { sessionId } : {}) });

    if (method === "Network.enable" && sessionId && this.refuseNetworkOn.has(sessionId)) {
      throw new Error("Network domain is not supported on this target");
    }

    if (method === "Target.setAutoAttach" && params.autoAttach === true) {
      const children = sessionId ? (this.nested[sessionId] ?? []) : this.top;

      for (const child of children) {
        this.emit({
          method: "Target.attachedToTarget",
          params: {
            sessionId: child.sessionId,
            targetInfo: { targetId: child.targetId, type: child.type, url: child.url, title: "" },
            waitingForDebugger: child.waitingForDebugger === true,
          },
        });
      }
    }

    return {};
  }

  onEvent(handler: (msg: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler);

    return () => {
      this.listeners.delete(handler);
    };
  }

  emit(msg: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(msg);
  }

  sent(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }
}

const sw: FakeTarget = { sessionId: "s-sw", targetId: "t-sw", type: "service_worker", url: `chrome-extension://${ID}/sw.js` };
const offscreen: FakeTarget = { sessionId: "s-off", targetId: "t-off", type: "page", url: `chrome-extension://${ID}/offscreen.html` };
const offscreenWorker: FakeTarget = { sessionId: "s-offw", targetId: "t-offw", type: "worker", url: `chrome-extension://${ID}/decoder.js`, waitingForDebugger: true };
const youtube: FakeTarget = { sessionId: "s-yt", targetId: "t-yt", type: "page", url: "https://www.youtube.com/watch?v=x" };
const extensionFrame: FakeTarget = { sessionId: "s-frame", targetId: "t-frame", type: "iframe", url: `chrome-extension://${ID}/overlay.html` };
const frameWorker: FakeTarget = { sessionId: "s-framew", targetId: "t-framew", type: "worker", url: `chrome-extension://${ID}/lens.js` };

function browser(): FakeConnection {
  return new FakeConnection([sw, offscreen, youtube], {
    "s-off": [offscreenWorker],
    "s-yt": [extensionFrame],
    "s-frame": [frameWorker],
  });
}

function request(sessionId: string, url: string, initiator?: unknown): Record<string, unknown> {
  return {
    method: "Network.requestWillBeSent",
    sessionId,
    params: { requestId: `${sessionId}-${url}`, request: { url, method: "POST" }, type: "Fetch", ...(initiator ? { initiator } : {}) },
  };
}

async function watchWhile(connection: FakeConnection, during: () => void, durationMs = 40) {
  const reading = watchNetwork(connection, { durationMs });
  await sleep(10);
  during();

  return reading;
}

describe("watchNetwork attaches to every target of the browser and what runs under them", () => {
  it("enables Network on the nested workers and extension frames, not only on the targets the browser lists", async () => {
    const connection = browser();
    const reading = await watchWhile(connection, () => {});

    const enabled = connection.sent("Network.enable").map((call) => call.sessionId);
    expect(enabled).toEqual(expect.arrayContaining(["s-sw", "s-off", "s-offw", "s-yt", "s-frame", "s-framew"]));
    expect(reading.attached.map((target) => target.type)).toEqual(
      expect.arrayContaining(["service_worker", "page", "worker", "iframe"]),
    );

    const autoAttached = connection.sent("Target.setAutoAttach").filter((call) => call.params.autoAttach === true);
    expect(autoAttached.map((call) => call.sessionId ?? "browser")).toEqual(
      expect.arrayContaining(["browser", "s-sw", "s-off", "s-offw", "s-yt", "s-frame", "s-framew"]),
    );

    expect(autoAttached.every((call) => call.params.flatten === true)).toBe(true);
  });

  it("resumes a target that attached paused on its first statement", async () => {
    const connection = browser();
    await watchWhile(connection, () => {});

    expect(connection.sent("Runtime.runIfWaitingForDebugger").map((call) => call.sessionId)).toEqual(["s-offw"]);
  });

  it("records each request with the target that made it, the initiator scripts and the time", async () => {
    const connection = browser();
    const reading = await watchWhile(connection, () => {
      connection.emit(
        request("s-offw", "https://example.com/upload", {
          type: "script",
          stack: { callFrames: [{ url: `chrome-extension://${ID}/decoder.js` }], parent: { callFrames: [{ url: `chrome-extension://${ID}/offscreen.js` }] } },
        }),
      );

      connection.emit({ method: "Network.webSocketCreated", sessionId: "s-sw", params: { requestId: "w", url: "wss://relay.example.com/" } });
    });

    expect(reading.requests).toHaveLength(2);
    const [fetched, socket] = reading.requests;
    expect(fetched).toMatchObject({
      url: "https://example.com/upload",
      method: "POST",
      kind: "request",
      resourceType: "Fetch",
      target: { type: "worker", url: `chrome-extension://${ID}/decoder.js` },
      initiators: [`chrome-extension://${ID}/decoder.js`, `chrome-extension://${ID}/offscreen.js`],
    });

    expect(fetched.at).toBeGreaterThanOrEqual(0);
    expect(socket).toMatchObject({ url: "wss://relay.example.com/", method: "WS", kind: "websocket", target: { type: "service_worker" } });
  });

  it("ignores a request from a session it never attached and reports a navigated target under its new url", async () => {
    const connection = browser();
    const reading = await watchWhile(connection, () => {
      connection.emit(request("s-unknown", "https://example.com/"));
      connection.emit({
        method: "Target.targetInfoChanged",
        params: { targetInfo: { targetId: "t-yt", type: "page", url: "https://www.youtube.com/watch?v=y" } },
      });

      connection.emit(request("s-yt", "https://i.ytimg.com/x.jpg"));
    });

    expect(reading.requests).toHaveLength(1);
    expect(reading.requests[0].target.url).toBe("https://www.youtube.com/watch?v=y");
  });

  it("watches a target the browser attaches through two sessions once, so its requests are not counted twice", async () => {
    const connection = new FakeConnection([sw, offscreen], { "s-off": [{ ...sw, sessionId: "s-sw-again" }] });
    const reading = await watchWhile(connection, () => {
      connection.emit(request("s-sw", "https://example.com/once"));
      connection.emit(request("s-sw-again", "https://example.com/once"));
    });

    expect(reading.attached.filter((target) => target.targetId === "t-sw")).toHaveLength(1);
    expect(reading.requests).toHaveLength(1);
    expect(connection.sent("Network.enable").map((call) => call.sessionId)).toEqual(["s-sw", "s-off"]);
    expect(connection.sent("Target.detachFromTarget").map((call) => call.params.sessionId)).toEqual(
      expect.arrayContaining(["s-sw", "s-off", "s-sw-again"]),
    );
  });

  it("names a target that refused network events instead of passing over it in silence", async () => {
    const connection = browser();
    connection.refuseNetworkOn.add("s-framew");
    const reading = await watchWhile(connection, () => {});

    expect(reading.enableErrors).toEqual([expect.stringContaining(`worker chrome-extension://${ID}/lens.js`)]);
  });

  it("turns auto-attach off and detaches from every session it still holds when the window ends", async () => {
    const connection = browser();
    const reading = await watchWhile(connection, () => {
      connection.emit({ method: "Target.detachedFromTarget", params: { sessionId: "s-offw" } });
    });

    const off = connection.sent("Target.setAutoAttach").filter((call) => call.params.autoAttach === false);
    expect(off.map((call) => call.sessionId ?? "browser")).toEqual(["browser"]);

    const detached = connection.sent("Target.detachFromTarget").map((call) => call.params.sessionId);
    expect(detached).toEqual(expect.arrayContaining(["s-sw", "s-off", "s-yt", "s-frame", "s-framew"]));
    expect(detached).not.toContain("s-offw");
    expect(reading.attached.find((target) => target.sessionId === "s-offw")?.detached).toBe(true);
    expect(reading.durationMs).toBeGreaterThanOrEqual(40);
  });
});

function seen(target: { type: string; url: string }, url: string, initiators: string[] = [], method = "GET"): SeenRequest {
  return { url, method, kind: method === "WS" ? "websocket" : "request", target, initiators, at: 1 };
}

const swTarget = { type: "service_worker", url: `chrome-extension://${ID}/sw.js` };
const youtubeTarget = { type: "page", url: "https://www.youtube.com/watch?v=x" };

describe("classifyRequests", () => {
  it("counts only the extension's own contexts and the content scripts it injected, and splits them by where they went", () => {
    const requests = [
      seen(swTarget, "https://api.example.com/track"),
      seen(swTarget, `chrome-extension://${ID}/model.json`),
      seen(swTarget, "ws://127.0.0.1:8081/reload", [], "WS"),
      seen(swTarget, `blob:chrome-extension://${ID}/3f2a`),
      seen(swTarget, "https://cdn.allowed.com/weights.bin"),
      seen(youtubeTarget, "https://telemetry.example.com/ping", [`chrome-extension://${ID}/content.js`]),
      seen(youtubeTarget, "https://i.ytimg.com/vi/x/hq.jpg"),
      seen({ type: "service_worker", url: `chrome-extension://${OTHER}/sw.js` }, "https://other.example.com/"),
    ];

    const result = classifyRequests(requests, { extensionIds: [ID], allow: ["allowed.com"] });

    expect(result.extensionRequests).toHaveLength(6);
    expect(result.onMachine.map((request) => request.url)).toEqual([
      `chrome-extension://${ID}/model.json`,
      "ws://127.0.0.1:8081/reload",
      `blob:chrome-extension://${ID}/3f2a`,
    ]);

    expect(result.allowed.map((request) => request.url)).toEqual(["https://cdn.allowed.com/weights.bin"]);
    expect(result.outside.map((request) => request.url)).toEqual([
      "https://api.example.com/track",
      "https://telemetry.example.com/ping",
    ]);

    expect(result.foreign).toBe(2);
  });

  it.each([
    ["https://localhost:3000/api", true],
    ["http://127.0.0.1:9222/json", true],
    ["http://127.1.2.3/", true],
    ["http://[::1]:8080/", true],
    ["http://app.localhost/", true],
    ["data:text/plain,hi", true],
    ["about:blank", true],
    [`chrome-extension://${ID}/x`, true],
    ["file:///tmp/x", true],
    ["https://localhost.example.com/", false],
    ["https://example.com/", false],
    ["not a url", false],
  ])("isOnMachine(%s) is %s", (url, expected) => {
    expect(isOnMachine(url)).toBe(expected);
  });

  it("matches an allowed host exactly or as a parent domain, after dropping a scheme and a wildcard", () => {
    expect(normalizeAllowHost("https://*.Example.com/path")).toBe("example.com");
    expect(normalizeAllowHost("API.example.com:443")).toBe("api.example.com");
    expect(hostAllowed("https://api.example.com/x", ["example.com"])).toBe(true);
    expect(hostAllowed("https://example.com/x", ["example.com"])).toBe(true);
    expect(hostAllowed("https://notexample.com/x", ["example.com"])).toBe(false);
    expect(hostAllowed("https://example.com.evil.net/x", ["example.com"])).toBe(false);
  });

  it("keeps only the extension's targets and counts them by type", () => {
    const targets: WatchedTarget[] = [
      { sessionId: "1", targetId: "a", type: "service_worker", url: `chrome-extension://${ID}/sw.js`, detached: false },
      { sessionId: "2", targetId: "b", type: "page", url: `chrome-extension://${ID}/offscreen.html`, detached: false },
      { sessionId: "3", targetId: "c", type: "page", url: "https://www.youtube.com/", detached: false },
      { sessionId: "4", targetId: "d", type: "worker", url: `chrome-extension://${ID}/lens.js`, detached: true },
    ];

    const own = extensionTargets(targets, [ID]);
    expect(own.map((target) => target.targetId)).toEqual(["a", "b", "d"]);
    expect(targetCensus(own)).toBe("1 page, 1 service_worker, 1 worker");
  });
});
