// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";
import { envelope } from "../lib/envelope";

import type { StubLink } from "../lib/network-stubs";

const live = vi.hoisted(() => ({ port: 9222 as number | null }));

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, resolveCdpPort: async () => (live.port === null ? null : { port: live.port, source: "contract" }) };
});

const { handler } = await import("../tools/network");
const { dropNetworkStubs, liveNetworkStubs, patternMatches, stubLinks, stubbedReadWarning } = await import("../lib/network-stubs");

interface Sent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

class FakeLink implements StubLink {
  sent: Sent[] = [];
  disconnected = 0;
  private handlers = new Set<(msg: Record<string, unknown>) => void>();
  private closeHandlers: Array<() => void> = [];

  async sendCommand(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    this.sent.push({ method, params, ...(sessionId ? { sessionId } : {}) });

    return {};
  }

  onEvent(handler: (msg: Record<string, unknown>) => void): () => void {
    this.handlers.add(handler);

    return () => this.handlers.delete(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  disconnect(): void {
    this.disconnected += 1;
  }

  async emit(msg: Record<string, unknown>): Promise<void> {
    for (const handler of this.handlers) handler(msg);

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  close(): void {
    for (const handler of this.closeHandlers) handler();
  }

  of(method: string): Sent[] {
    return this.sent.filter((entry) => entry.method === method);
  }
}

let project: string;
let link: FakeLink;
let opened: number[];
const originalOpen = stubLinks.open;

const attach = (sessionId: string, type: string, url: string, waiting = true) =>
  link.emit({
    method: "Target.attachedToTarget",
    params: { sessionId, waitingForDebugger: waiting, targetInfo: { targetId: `t-${sessionId}`, type, url } },
  });

const paused = (sessionId: string, requestId: string, method: string, url: string, networkId = `net-${requestId}`) =>
  link.emit({ method: "Fetch.requestPaused", sessionId, params: { requestId, networkId, request: { url, method } } });

const call = async (args: Record<string, unknown>) => JSON.parse(await handler({ projectPath: project, browser: "chrome", ...args } as never));

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-network-stubs-"));
  link = new FakeLink();
  opened = [];
  live.port = 9222;
  stubLinks.open = async (port: number) => {
    opened.push(port);

    return link;
  };
});

afterEach(() => {
  dropNetworkStubs(project, "chrome");
  stubLinks.open = originalOpen;
  fs.rmSync(project, { recursive: true, force: true });
});

describe("extension_network refuses what it cannot carry", () => {
  it("refuses a Firefox session naming the engine bridge, and opens nothing", async () => {
    const frame = await call({ action: "add", browser: "firefox", url: "https://api.example.com/*", status: 500 });

    expect(frame.ok).toBe(false);
    expect(frame.status).toBe("not-supported");
    expect(frame.error.code).toBe("E_UNSUPPORTED_BROWSER");
    expect(frame.error.message).toContain("Firefox bridge does not carry request interception yet");
    expect(frame.hint).toContain("extension_dev on chrome, chromium or edge");
    expect(opened).toEqual([]);
  });

  it("refuses a project with no debug port naming extension_dev", async () => {
    live.port = null;
    const frame = await call({ action: "add", url: "https://api.example.com/*", status: 500 });

    expect(frame.ok).toBe(false);
    expect(frame.status).toBe("no-session");
    expect(frame.error.code).toBe("E_NO_SESSION");
    expect(frame.hint).toContain("extension_dev");
    expect(opened).toEqual([]);
  });

  it("refuses a rule with no url, or body beside json, before touching the browser", async () => {
    const noUrl = await call({ action: "add", status: 500 });
    expect(noUrl.status).toBe("bad-request");
    expect(noUrl.error.message).toContain("url is required");

    const both = await call({ action: "add", url: "https://x/", body: "a", json: { a: 1 } });
    expect(both.status).toBe("bad-request");
    expect(both.error.message).toContain("not both");
    expect(opened).toEqual([]);
  });
});

describe("extension_network add installs Fetch interception on every attached context", () => {
  it("attaches with waitForDebuggerOnStart, enables Fetch with the rule's pattern on a waiting target, then lets it run", async () => {
    const frame = await call({ action: "add", url: "https://api.example.com/*", status: 500, json: { error: "down" } });

    expect(frame.ok).toBe(true);
    expect(frame.status).toBe("rule-added");
    expect(frame.value.rule).toMatchObject({ id: "stub-1", method: "ANY", url: "https://api.example.com/*", status: 500, contentType: "application/json", hits: 0 });
    expect(frame.value.live).toBe(true);
    expect(frame.value.covers).toContain("startup included, were not covered");
    expect(frame.hint).toContain("extension_reload replays the background's startup");
    expect(frame.hint).toContain('extension_network {action: "requests"}');
    expect(opened).toEqual([9222]);
    expect(link.of("Target.setAutoAttach")[0]?.params).toEqual({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

    await attach("sw", "service_worker", "chrome-extension://abc/sw.js");

    const bySession = link.sent.filter((entry) => entry.sessionId === "sw").map((entry) => entry.method);
    expect(bySession).toEqual(["Network.enable", "Fetch.enable", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);
    expect(link.of("Fetch.enable")[0]?.params).toEqual({ patterns: [{ urlPattern: "https://api.example.com/*", requestStage: "Request" }] });
  });

  it("re-arms the live contexts with every pattern when a second rule is added", async () => {
    await call({ action: "add", url: "https://api.example.com/*", status: 500 });
    await attach("popup", "page", "chrome-extension://abc/popup.html", false);
    await call({ action: "add", id: "users", method: "post", url: "https://api.example.com/users", status: 201, body: "ok" });

    const enables = link.of("Fetch.enable").filter((entry) => entry.sessionId === "popup");
    expect(enables.at(-1)?.params).toEqual({
      patterns: [
        { urlPattern: "https://api.example.com/*", requestStage: "Request" },
        { urlPattern: "https://api.example.com/users", requestStage: "Request" },
      ],
    });

    const listed = await call({ action: "list" });
    expect(listed.status).toBe("rules-listed");
    expect(listed.value.rules.map((rule: { id: string; method: string }) => [rule.id, rule.method])).toEqual([["stub-1", "ANY"], ["users", "POST"]]);
    expect(listed.hint).toContain("2 rule(s) are live");
  });
});

describe("extension_network answers matching requests and records hits and misses", () => {
  it("fulfills a matching request with the status, the JSON body and a CORS header, and continues the rest", async () => {
    await call({ action: "add", url: "https://api.example.com/*", status: 500, json: { error: "down" } });
    await attach("popup", "page", "chrome-extension://abc/popup.html", false);

    await paused("popup", "r1", "GET", "https://api.example.com/items?page=1");
    await paused("popup", "r2", "GET", "https://cdn.example.net/logo.png");

    const fulfilled = link.of("Fetch.fulfillRequest");
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.params).toMatchObject({ requestId: "r1", responseCode: 500 });
    expect(Buffer.from(String(fulfilled[0]?.params.body), "base64").toString("utf8")).toBe('{"error":"down"}');
    expect(fulfilled[0]?.params.responseHeaders).toEqual([
      { name: "Content-Type", value: "application/json" },
      { name: "Access-Control-Allow-Origin", value: "*" },
    ]);
    expect(link.of("Fetch.continueRequest").map((entry) => entry.params)).toEqual([{ requestId: "r2" }]);

    const requests = await call({ action: "requests" });
    expect(requests.status).toBe("requests-read");
    expect(requests.value.counts).toEqual({ hit: 1, missed: 1, total: 2 });
    expect(requests.value.hit[0]).toMatchObject({ method: "GET", url: "https://api.example.com/items?page=1", ruleId: "stub-1", target: { type: "page", url: "chrome-extension://abc/popup.html" } });
    expect(requests.value.missed[0]).toMatchObject({ url: "https://cdn.example.net/logo.png" });
    expect(requests.value.missed[0].ruleId).toBeUndefined();
    expect(requests.value.rules[0].hits).toBe(1);
    expect(requests.hint).toContain("1 request(s) were answered by a rule and 1 reached their real server");
  });

  it("matches the method, counts a request once across Network and Fetch events, and names a rule nothing hit", async () => {
    await call({ action: "add", id: "users", method: "POST", url: "https://api.example.com/users", status: 201, body: "made" });
    await attach("sw", "service_worker", "chrome-extension://abc/sw.js", false);

    await link.emit({ method: "Network.requestWillBeSent", sessionId: "sw", params: { requestId: "net-g1", request: { url: "https://api.example.com/users", method: "GET" } } });
    await paused("sw", "g1", "GET", "https://api.example.com/users", "net-g1");

    expect(link.of("Fetch.fulfillRequest")).toHaveLength(0);
    expect(link.of("Fetch.continueRequest")).toHaveLength(1);

    const requests = await call({ action: "requests" });
    expect(requests.value.counts).toEqual({ hit: 0, missed: 1, total: 1 });
    expect(requests.hint).toContain("Rule(s) users answered nothing yet");
    expect(requests.hint).toContain("extension_reload replays the background's startup");
  });

  it("answers no-rules for requests before any rule is live", async () => {
    const frame = await call({ action: "requests" });

    expect(frame.ok).toBe(true);
    expect(frame.status).toBe("no-rules");
    expect(frame.hint).toContain('extension_network {action: "add"');
  });
});

describe("extension_network rules are session scoped", () => {
  it("clear disables Fetch on every context, drops the record, and list says none is live", async () => {
    await call({ action: "add", url: "https://api.example.com/*", status: 500 });
    await attach("popup", "page", "chrome-extension://abc/popup.html", false);
    await paused("popup", "r1", "GET", "https://api.example.com/items");

    const cleared = await call({ action: "clear" });
    expect(cleared.status).toBe("rules-cleared");
    expect(cleared.value.cleared).toBe(1);
    expect(link.disconnected).toBe(1);
    expect(liveNetworkStubs(project)).toEqual([]);

    const listed = await call({ action: "list" });
    expect(listed.value.rules).toEqual([]);
    expect(listed.value.live).toBe(false);
    expect(listed.hint).toContain("No network stub is live");

    const again = await call({ action: "clear" });
    expect(again.status).toBe("nothing-to-clear");
  });

  it("forgets the rules when the browser's connection closes, so a new session starts with none", async () => {
    await call({ action: "add", url: "https://api.example.com/*", status: 500 });
    expect(liveNetworkStubs(project)).toHaveLength(1);

    link.close();

    expect(liveNetworkStubs(project)).toEqual([]);
    const listed = await call({ action: "list" });
    expect(listed.value.rules).toEqual([]);
  });
});

describe("a read made while rules are live says so", () => {
  it("warns on a reader's answer through the dispatcher, and stops once the rules are cleared", async () => {
    await call({ action: "add", url: "https://api.example.com/*", status: 500 });

    const reader: ToolModule = {
      schema: { name: "extension_dom_snapshot", description: "fake", inputSchema: { type: "object", properties: { projectPath: { type: "string" } } } },
      handler: async () => envelope({ ok: true, command: "extension_dom_snapshot", status: "snapshot", value: { nodes: [] } }),
    };
    const dispatch = createToolDispatcher({ tools: [reader], options: { features: ["local"], noShip: false } });

    const frame = JSON.parse((await dispatch({ name: "extension_dom_snapshot", arguments: { projectPath: project } })).content[0]!.text);
    expect(frame.warnings).toHaveLength(1);
    expect(frame.warnings[0]).toContain("1 network stub rule(s) from extension_network are live on the chrome session");
    expect(frame.warnings[0]).toContain('extension_network {action: "requests"}');

    expect(stubbedReadWarning("extension_build", { projectPath: project })).toBeUndefined();
    expect(stubbedReadWarning("extension_eval", { projectPath: project, browser: "firefox" })).toBeUndefined();

    await call({ action: "clear" });
    const clean = JSON.parse((await dispatch({ name: "extension_dom_snapshot", arguments: { projectPath: project } })).content[0]!.text);
    expect(clean.warnings).toEqual([]);
  });
});

describe("patternMatches", () => {
  it("matches an exact URL, a * glob and a ? glob, and nothing past the pattern", () => {
    expect(patternMatches("https://api.example.com/users", "https://api.example.com/users")).toBe(true);
    expect(patternMatches("https://api.example.com/users", "https://api.example.com/users?x=1")).toBe(false);
    expect(patternMatches("https://api.example.com/*", "https://api.example.com/users?x=1")).toBe(true);
    expect(patternMatches("https://api.example.com/*", "https://api.example.org/users")).toBe(false);
    expect(patternMatches("https://api.example.com/v?/items", "https://api.example.com/v1/items")).toBe(true);
    expect(patternMatches("https://api.example.com/v?/items", "https://api.example.com/v10/items")).toBe(false);
    expect(patternMatches("https://a.b/c.d", "https://a.b/cxd")).toBe(false);
  });
});
