import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logsPath, readyContractPath } from "../lib/session-paths";
import { readyContract, safariDevContract } from "./fixtures/engine-answers";
import {
  readWebDriverSession,
  sameDocument,
  WebDriverClient,
} from "../lib/webdriver";
import * as assertTool from "../tools/assert";
import * as evalTool from "../tools/eval";
import * as logsTool from "../tools/logs";
import * as openTool from "../tools/open";
import * as waitTool from "../tools/wait";

import type * as ActModule from "../lib/act";

const act = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      act.calls.push(cli);

      return JSON.stringify({ ok: true, command: cli[0], status: "ok", value: { via: "bridge", cli } });
    },
  };
});

const BROWSER = "safari";

interface FakeSafari {
  port: number;
  calls: Array<{ method: string; route: string; body: unknown }>;
  url: string;
  roots: Array<{ owner: string }>;
  sessionEnded: boolean;
  close(): Promise<void>;
}

async function startFakeSafari(): Promise<FakeSafari> {
  const state: FakeSafari = {
    port: 0,
    calls: [],
    url: "https://start.test/",
    roots: [],
    sessionEnded: false,
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

      if (state.sessionEnded && route.startsWith("/session/S-9")) {
        return reply(404, {
          error: "invalid session id",
          message: "Session with id S-9 is not active",
        });
      }

      if (route === "/session/S-9/url" && method === "GET") {
        return reply(200, state.url);
      }

      if (route === "/session/S-9/url" && method === "POST") {
        const wanted = String((body as { url: string }).url);

        try {
          state.url = new URL(wanted).href ? wanted : state.url;
        } catch {
          return reply(400, {
            error: "invalid argument",
            message: "Could not parse requested URL",
          });
        }

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

  function sessionFields(): Record<string, unknown> {
    return {
      runId: "run-safari",
      extensionId: "dev.extensionjs.Demo.Extension",
      distPath: path.join(project, "dist", BROWSER),
      manifestPath: path.join(project, "dist", BROWSER, "manifest.json"),
      logsPath: logsPath(project, BROWSER),
    };
  }

  function writeContract(contract: Record<string, unknown>): void {
    const file = readyContractPath(project, BROWSER);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(contract));
  }

  function writeReady(extra: Record<string, unknown>): void {
    writeContract(readyContract("dev", BROWSER, { ...sessionFields(), ...extra }));
  }

  function withWindow(): void {
    writeContract(
      safariDevContract({ port: safari.port, sessionId: "S-9" }, sessionFields()),
    );
  }

  function writeLogs(events: Array<Record<string, unknown>>): void {
    const file = logsPath(project, BROWSER);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
    );
  }

  it("reads the session only when ready.json carries both fields (a port alone is a hand-cut contract no engine writes)", () => {
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
        context: "page",
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
      context: "page",
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

  function pageEval(url: string) {
    return evalTool
      .handler({
        projectPath: project,
        browser: BROWSER,
        context: "page",
        expression: "document.title",
        url,
      })
      .then((raw) => JSON.parse(raw));
  }

  function navigations(): string[] {
    return safari.calls
      .filter((c) => c.method === "POST" && c.route === "/session/S-9/url")
      .map((c) => (c.body as { url: string }).url);
  }

  it("navigates to a host-and-port url as http, the pattern Chromium and Firefox accept", async () => {
    withWindow();
    const parsed = await pageEval("127.0.0.1:8765");

    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("evaluated");
    expect(navigations()).toEqual(["http://127.0.0.1:8765/"]);
  });

  it("evaluates in place when the window already shows a page the host-and-port url matches", async () => {
    withWindow();
    safari.url = "http://127.0.0.1:8765/demo.html";
    const parsed = await pageEval("127.0.0.1:8765");

    expect(parsed.ok).toBe(true);
    expect(parsed.value.url).toBe("http://127.0.0.1:8765/demo.html");
    expect(navigations()).toEqual([]);
  });

  it("evaluates in place on a match pattern that covers the page, and refuses one it cannot open", async () => {
    withWindow();
    safari.url = "http://127.0.0.1:8765/demo.html";
    const covered = await pageEval("*://127.0.0.1/*");

    expect(covered.ok).toBe(true);
    expect(navigations()).toEqual([]);

    const uncovered = await pageEval("*://example.test/*");

    expect(uncovered.ok).toBe(false);
    expect(uncovered.error.code).toBe("E_NO_MATCHING_TARGET");
    expect(uncovered.error.message).toContain("http://127.0.0.1:8765/demo.html");
    expect(navigations()).toEqual([]);
  });

  it("names an ended WebDriver session on a page eval instead of an internal error", async () => {
    withWindow();
    safari.sessionEnded = true;
    const parsed = await pageEval("127.0.0.1:8765");

    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("webdriver-session-ended");
    expect(parsed.error.code).toBe("E_WEBDRIVER_SESSION_ENDED");
    expect(parsed.error.message).toContain("S-9");
    expect(parsed.hint).toContain("enableExtension: true");
    expect(parsed.hint).toContain("no Settings trip");
    expect(parsed.hint).not.toContain("extension_stop");
  });

  it("repeats a page eval until it is truthy over the automation session", async () => {
    withWindow();
    const parsed = JSON.parse(
      await evalTool.handler({
        projectPath: project,
        browser: BROWSER,
        expression: "document.title",
        context: "page",
        url: "https://start.test/",
        until: { timeoutMs: 3000 },
      }),
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("condition-met");
    expect(parsed.value.result).toEqual({ echoed: "return (document.title);" });
  });

  function writeDetached(extra: Record<string, unknown> = {}): void {
    writeContract(
      safariDevContract(
        { port: safari.port, sessionId: "S-9" },
        {
          ...sessionFields(),
          executorAttachedAt: "2026-10-17T16:47:47.372Z",
          executorDetachedAt: "2026-10-17T16:48:17.376Z",
          runtime: "detached",
          ...extra,
        },
      ),
    );
  }

  function waitOnce() {
    return waitTool
      .handler({ projectPath: project, browser: BROWSER, timeoutMs: 1000 })
      .then((raw) => JSON.parse(raw));
  }

  it("reads a detached executor beside a live automation session as an asleep background", async () => {
    writeDetached();
    const parsed = await waitOnce();

    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("background-asleep");
    expect(parsed.value.backgroundAsleep).toBe(true);
    expect(parsed.value.browserAttached).toBe(false);
    expect(parsed.value.executorDetachedAt).toBe("2026-10-17T16:48:17.376Z");
    expect(parsed.hint).not.toContain("extension_stop");
  });

  it("names an ended WebDriver session instead of a gone browser", async () => {
    writeDetached();
    safari.sessionEnded = true;
    const parsed = await waitOnce();

    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("webdriver-session-ended");
    expect(parsed.error.code).toBe("E_WEBDRIVER_SESSION_ENDED");
    expect(parsed.error.message).toContain("S-9");
    expect(parsed.error.message).not.toContain("the browser is gone");
    expect(parsed.hint).toContain('browser: "safari", replace: true and enableExtension: true');
  });

  it("still calls the browser gone when neither the driver nor a recorded pid answers", async () => {
    writeDetached({ browserPid: 999999 });
    await safari.close();
    const parsed = await waitOnce();

    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("browser-gone");
    expect(parsed.error.code).toBe("E_SESSION_EXITED");
  });

  it("sends content and background eval down the bridge, not the window", async () => {
    withWindow();
    act.calls.length = 0;

    for (const context of ["content", "background", undefined]) {
      const parsed = JSON.parse(
        await evalTool.handler({
          projectPath: project,
          browser: BROWSER,
          expression: "1",
          ...(context ? { context } : {}),
        }),
      );
      expect(parsed.value.via).toBe("bridge");
    }

    expect(act.calls).toHaveLength(3);
    expect(safari.calls).toHaveLength(0);
  });

  it("sends an explicit page eval down the bridge when no window is recorded", async () => {
    writeReady({});
    act.calls.length = 0;
    const parsed = JSON.parse(
      await evalTool.handler({
        projectPath: project,
        browser: BROWSER,
        context: "page",
        expression: "1",
      }),
    );
    expect(parsed.value.via).toBe("bridge");
    expect(act.calls).toHaveLength(1);
  });

  it("reports a thrown expression as an eval failure, not a crash", async () => {
    withWindow();
    const parsed = JSON.parse(
      await evalTool.handler({
        projectPath: project,
        browser: BROWSER,
        context: "page",
        expression: "(() => { throw 1 })()",
      }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("eval-failed");
    expect(parsed.error.message).toContain("boom from the page");
  });

  it("reads the roots as soon as the navigated page shows one instead of waiting a fixed 1200 ms", async () => {
    withWindow();
    safari.roots = [
      { owner: "content_scripts/content-0::script-0@dev.extensionjs.Demo.Extension (TEAM)" },
    ];

    const started = Date.now();

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
    expect(safari.calls.some((c) => c.route === "/session/S-9/url")).toBe(true);
    expect(Date.now() - started).toBeLessThan(600);
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

  it("stays inconclusive on Safari where no log line exists, naming the bridge", async () => {
    withWindow();
    const parsed = JSON.parse(
      await assertTool.handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "background-worker-booted" },
          { assert: "console-errors-empty" },
        ],
      }),
    );
    const checks = parsed.value.checks as Array<{
      outcome: string;
      settledBy: string;
    }>;
    expect(checks.map((c) => c.outcome)).toEqual(["inconclusive", "inconclusive"]);
    for (const check of checks) expect(check.settledBy.length).toBeGreaterThan(10);
    expect(checks[0].settledBy).toContain("bridge");
    expect(safari.calls).toHaveLength(0);
  });

  it("reads storage-key-present over the bridge on Safari", async () => {
    withWindow();
    act.calls.length = 0;
    await assertTool.handler({
      projectPath: project,
      browser: BROWSER,
      expect: [{ assert: "storage-key-present", key: "settings" }],
    });

    expect(act.calls.some((cli) => cli[0] === "storage")).toBe(true);
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
