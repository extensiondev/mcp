import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { logsPath, readyContractPath } from "../lib/session-paths";
import {
  readWebDriverSession,
  sameDocument,
  WebDriverClient,
} from "../lib/webdriver";
import * as assertTool from "../tools/assert";
import * as evalTool from "../tools/eval";
import * as logsTool from "../tools/logs";
import * as openTool from "../tools/open";

const BROWSER = "safari";

interface FakeSafari {
  port: number;
  calls: Array<{ method: string; route: string; body: unknown }>;
  url: string;
  roots: Array<{ owner: string }>;
  close(): Promise<void>;
}

async function startFakeSafari(): Promise<FakeSafari> {
  const state: FakeSafari = {
    port: 0,
    calls: [],
    url: "https://start.test/",
    roots: [],
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      const route = String(req.url || "");
      const method = String(req.method || "");
      const body = raw ? JSON.parse(raw) : null;
      state.calls.push({ method, route, body });
      const reply = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ value }));
      };
      if (route === "/session/S-9/url" && method === "GET") {
        return reply(200, state.url);
      }
      if (route === "/session/S-9/url" && method === "POST") {
        state.url = String((body as { url: string }).url);
        return reply(200, null);
      }
      if (route === "/session/S-9/execute/sync") {
        const script = String((body as { script: string }).script);
        if (script.includes("data-extension-root")) {
          return reply(200, {
            roots: state.roots.length,
            owners: state.roots.map((r) => r.owner),
            url: state.url,
            title: "Fake",
          });
        }
        if (script.includes("throw")) {
          return reply(500, {
            error: "javascript error",
            message: "boom from the page",
          });
        }
        return reply(200, { echoed: script });
      }
      reply(404, { error: "unknown command", message: route });
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  state.port = typeof address === "object" && address ? address.port : 0;
  state.close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

describe("Safari sessions over the dev window's WebDriver connection", () => {
  let project: string;
  let safari: FakeSafari;

  beforeEach(async () => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-safari-"));
    safari = await startFakeSafari();
    const manifestDir = path.join(project, "dist", BROWSER);
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, "manifest.json"),
      JSON.stringify({
        name: "Demo",
        version: "1.0.0",
        manifest_version: 3,
        content_scripts: [
          { matches: ["https://example.test/*"], js: ["content.js"] },
        ],
      }),
    );
  });

  afterEach(async () => {
    await safari.close();
    fs.rmSync(project, { recursive: true, force: true });
  });

  function writeReady(extra: Record<string, unknown>): void {
    const file = readyContractPath(project, BROWSER);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        status: "ready",
        command: "dev",
        browser: BROWSER,
        runId: "run-safari",
        pid: process.pid,
        extensionId: "dev.extensionjs.Demo.Extension",
        ...extra,
      }),
    );
  }

  function withWindow(): void {
    writeReady({ webdriverPort: safari.port, webdriverSessionId: "S-9" });
  }

  function writeLogs(events: Array<Record<string, unknown>>): void {
    const file = logsPath(project, BROWSER);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
    );
  }

  it("reads the session only when ready.json carries both fields", () => {
    writeReady({});
    expect(readWebDriverSession(project, BROWSER)).toBeNull();
    writeReady({ webdriverPort: safari.port });
    expect(readWebDriverSession(project, BROWSER)).toBeNull();
    withWindow();
    expect(readWebDriverSession(project, BROWSER)).toEqual({
      port: safari.port,
      sessionId: "S-9",
    });
  });

  it("compares documents without their hash, query, or trailing slash", () => {
    expect(sameDocument("https://a.test/x/?q=1#h", "https://a.test/x")).toBe(
      true,
    );
    expect(sameDocument("https://a.test/x", "https://a.test/y")).toBe(false);
    expect(sameDocument(null, "https://a.test/")).toBe(false);
  });

  it("evaluates in the page over the recorded session", async () => {
    withWindow();
    const parsed = JSON.parse(
      await evalTool.handler({
        projectPath: project,
        browser: BROWSER,
        expression: "1 + 1",
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("evaluated");
    expect(parsed.value.context).toBe("page");
    expect(parsed.value.result).toEqual({ echoed: "return (1 + 1);" });
  });

  it("navigates first when eval names a url the window is not on", async () => {
    withWindow();
    await evalTool.handler({
      projectPath: project,
      browser: BROWSER,
      expression: "document.title",
      url: "https://example.test/page",
    });
    expect(
      safari.calls.some(
        (c) =>
          c.method === "POST" &&
          c.route === "/session/S-9/url" &&
          (c.body as { url: string }).url === "https://example.test/page",
      ),
    ).toBe(true);
  });

  it("refuses every context but page, by name", async () => {
    withWindow();
    const parsed = JSON.parse(
      await evalTool.handler({
        projectPath: project,
        browser: BROWSER,
        expression: "1",
        context: "background",
      }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("unsupported-context");
    expect(parsed.error.message).toContain('"background"');
    expect(safari.calls).toHaveLength(0);
  });

  it("answers no-session with the Safari hint when nothing is recorded", async () => {
    writeReady({});
    const parsed = JSON.parse(
      await evalTool.handler({
        projectPath: project,
        browser: BROWSER,
        expression: "1",
      }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("no-session");
    expect(parsed.hint).toContain("one automation session");
  });

  it("reports a thrown expression as an eval failure, not a crash", async () => {
    withWindow();
    const parsed = JSON.parse(
      await evalTool.handler({
        projectPath: project,
        browser: BROWSER,
        expression: "(() => { throw 1 })()",
      }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("eval-failed");
    expect(parsed.error.message).toContain("boom from the page");
  });

  it("passes content-script-injected on a root owned by this extension", async () => {
    withWindow();
    safari.roots = [
      { owner: "content_scripts/content-0::script-0@dev.extensionjs.Demo.Extension (TEAM)" },
    ];
    const parsed = JSON.parse(
      await assertTool.handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "content-script-injected", url: "https://example.test/page" },
        ],
      }),
    );
    const check = parsed.value.checks[0];
    expect(check.outcome).toBe("pass");
    expect(check.evidence.owners).toHaveLength(1);
    expect(
      safari.calls.some(
        (c) =>
          c.method === "POST" &&
          c.route === "/session/S-9/url" &&
          (c.body as { url: string }).url === "https://example.test/page",
      ),
    ).toBe(true);
  });

  it("stays inconclusive on a page with no owned root, naming the marker", async () => {
    withWindow();
    safari.roots = [{ owner: "someone-else@dev.other.Extension" }];
    const parsed = JSON.parse(
      await assertTool.handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "content-script-injected", url: "https://example.test/page" },
        ],
      }),
    );
    const check = parsed.value.checks[0];
    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toContain("none of which names this extension");
    expect(check.settledBy).toContain("data-extension-root");
    expect(parsed.ok).toBe(false);
  });

  it("does not navigate when the window already shows the page", async () => {
    withWindow();
    safari.url = "https://example.test/page/";
    safari.roots = [{ owner: "x@dev.extensionjs.Demo.Extension" }];
    await assertTool.handler({
      projectPath: project,
      browser: BROWSER,
      expect: [
        { assert: "content-script-injected", url: "https://example.test/page" },
      ],
    });
    expect(
      safari.calls.filter(
        (c) => c.method === "POST" && c.route === "/session/S-9/url",
      ),
    ).toHaveLength(0);
  });

  it("passes content-script-injected on a bridge log line before touching the window", async () => {
    withWindow();
    writeLogs([
      { type: "header", runId: "run-safari", v: 1 },
      {
        context: "content",
        level: "log",
        seq: 1,
        url: "https://example.test/page",
        message: "[From the page context] Hello from content_scripts!",
        runId: "run-safari",
      },
    ]);
    const parsed = JSON.parse(
      await assertTool.handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "content-script-injected", url: "https://example.test/page" },
        ],
      }),
    );
    expect(parsed.value.checks[0].outcome).toBe("pass");
    expect(parsed.value.checks[0].detail).toContain("log line");
    expect(safari.calls).toHaveLength(0);
  });

  it("passes background-worker-booted on a background line from the bridge", async () => {
    withWindow();
    writeLogs([
      { type: "header", runId: "run-safari", v: 1 },
      {
        context: "background",
        level: "log",
        seq: 1,
        message: "[From the background context] Hello",
        runId: "run-safari",
      },
    ]);
    const parsed = JSON.parse(
      await assertTool.handler({
        projectPath: project,
        browser: BROWSER,
        expect: [{ assert: "background-worker-booted" }],
      }),
    );
    expect(parsed.value.checks[0].outcome).toBe("pass");
    expect(parsed.value.checks[0].detail).toContain("bridge");
  });

  it("stays inconclusive on Safari where nothing observable exists, naming the attended path", async () => {
    withWindow();
    const parsed = JSON.parse(
      await assertTool.handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "background-worker-booted" },
          { assert: "surface-rendered", surface: "popup" },
          { assert: "storage-key-present", key: "settings" },
          { assert: "console-errors-empty" },
        ],
      }),
    );
    const checks = parsed.value.checks as Array<{
      id: string;
      outcome: string;
      detail: string;
      settledBy: string;
    }>;
    expect(checks.map((c) => c.outcome)).toEqual([
      "inconclusive",
      "inconclusive",
      "inconclusive",
      "inconclusive",
    ]);
    for (const check of checks) expect(check.settledBy.length).toBeGreaterThan(10);
    expect(checks[0].settledBy).toContain("bridge");
    expect(checks[1].detail).toContain("main world only");
    expect(checks[2].detail).toContain("main world only");
    expect(safari.calls).toHaveLength(0);
  });

  it("explains a missing Safari log file in Safari's terms", async () => {
    withWindow();
    const parsed = JSON.parse(
      await logsTool.handler({ projectPath: project, browser: BROWSER }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("no-log-file");
    expect(parsed.error.code).toBe("E_LOGS_MISSING");
    expect(parsed.hint).toContain("bridge");
  });

  it("reads the bridge log file on Safari like any other engine", async () => {
    withWindow();
    writeLogs([
      { type: "header", runId: "run-safari", v: 1 },
      {
        context: "content",
        level: "log",
        seq: 1,
        url: "https://example.test/page",
        message: "hello from safari content",
        runId: "run-safari",
      },
    ]);
    const parsed = JSON.parse(
      await logsTool.handler({ projectPath: project, browser: BROWSER }),
    );
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed.value)).toContain("hello from safari content");
  });

  it("navigates the window through extension_open url", async () => {
    withWindow();
    const parsed = JSON.parse(
      await openTool.handler({
        projectPath: project,
        browser: BROWSER,
        url: "https://example.test/next",
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("navigated");
    expect(parsed.value.url).toBe("https://example.test/next");
  });

  it("reports the window gone when the driver stops answering", async () => {
    withWindow();
    await safari.close();
    const client = new WebDriverClient({
      port: safari.port,
      sessionId: "S-9",
    });
    expect(await client.alive()).toBe(false);
    const parsed = JSON.parse(
      await assertTool.handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "content-script-injected", url: "https://example.test/page" },
        ],
      }),
    );
    expect(parsed.value.checks[0].outcome).toBe("inconclusive");
    expect(parsed.value.checks[0].detail).toContain("could not be read");
  });
});
