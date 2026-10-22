import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readyContractPath } from "../lib/session-paths";
import { wakePlan, wakeUrlFromMatchPattern } from "../lib/safari-background";
import { actFailure, actFrame, safariDevContract } from "./fixtures/engine-answers";

import type * as ExecModule from "../lib/exec";
import type * as SafariBackgroundModule from "../lib/safari-background";

const cli = vi.hoisted(() => ({
  calls: [] as string[][],
  replies: [] as Array<{ code: number; stdout: string; stderr: string }>,
}));

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cli.calls.push(args);

      return cli.replies.shift() ?? { code: 0, stdout: JSON.stringify(actFrame(args[0] ?? "storage", {})), stderr: "" };
    },
  };
});

vi.mock("../lib/safari-background", async (importOriginal) => {
  const actual = await importOriginal<typeof SafariBackgroundModule>();

  return { ...actual, SAFARI_WAKE_WAIT_MS: 400 };
});

const { runActVerb } = await import("../lib/act");
const storageTool = await import("../tools/storage");

const MV3_WORDING =
  "no executor connected: the extension's service worker disconnected 15s ago, MV3 workers idle out and reconnect on their own";

const DETACHED = {
  executorAttachedAt: "2026-10-22T22:00:13.226Z",
  executorDetachedAt: "2026-10-22T22:05:15.448Z",
  runtime: "detached",
};

interface FakeDriver {
  port: number;
  url: string;
  calls: string[];
  onEvent: () => void;
  close(): Promise<void>;
}

async function startFakeDriver(): Promise<FakeDriver> {
  const state: FakeDriver = { port: 0, url: "about:blank", calls: [], onEvent: () => {}, close: async () => {} };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });

    req.on("end", () => {
      const route = `${req.method} ${req.url}`;
      state.calls.push(route);

      const reply = (value: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ value }));
      };

      if (route === "GET /session/S-1/url") return reply(state.url);

      if (route === "POST /session/S-1/url") {
        state.url = String((JSON.parse(raw) as { url: string }).url);
        state.onEvent();

        return reply(null);
      }

      if (route === "POST /session/S-1/refresh") {
        state.onEvent();

        return reply(null);
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: { error: "unknown command", message: route } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  state.port = typeof address === "object" && address ? address.port : 0;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));

  return state;
}

function noExecutor(verb: string) {
  return {
    code: 1,
    stdout: JSON.stringify(actFailure(verb, { name: "ControlUnavailable", code: "E_CONTROL_UNAVAILABLE", message: MV3_WORDING })),
    stderr: "",
  };
}

describe("a Safari call that finds the background unloaded wakes it once before answering", () => {
  let project: string;
  let driver: FakeDriver;

  beforeEach(async () => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-safari-wake-"));
    driver = await startFakeDriver();
    cli.calls.length = 0;
    cli.replies.length = 0;
    const dist = path.join(project, "dist", "safari");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "manifest.json"),
      JSON.stringify({ name: "Rebeccat", manifest_version: 3, content_scripts: [{ matches: ["https://example.test/*"], js: ["content.js"] }] }),
    );
  });

  afterEach(async () => {
    await driver.close();
    fs.rmSync(project, { recursive: true, force: true });
  });

  function writeContract(browser: string, extra: Record<string, unknown>): void {
    const file = readyContractPath(project, browser);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(extra));
  }

  function withSession(extra: Record<string, unknown> = {}): void {
    writeContract("safari", safariDevContract({ port: driver.port, sessionId: "S-1" }, { ...DETACHED, ...extra }));
  }

  function reattachOnEvent(): void {
    driver.onEvent = () => {
      withSession({ executorAttachedAt: new Date().toISOString(), runtime: "attached" });
    };
  }

  it("sends the automation window to a content-script page, waits for the executor, runs the verb again and says woke: true", async () => {
    withSession();
    reattachOnEvent();
    cli.replies.push(noExecutor("storage"), { code: 0, stdout: JSON.stringify(actFrame("storage", { theme: "dark" })), stderr: "" });

    const parsed = JSON.parse(await runActVerb(["storage", "get", project, "--browser", "safari"], project, undefined, "extension_storage"));

    expect(parsed.ok).toBe(true);
    expect(parsed.value).toMatchObject({ theme: "dark", woke: true });
    expect(cli.calls).toHaveLength(2);
    expect(driver.calls).toContain("POST /session/S-1/url");
    expect(driver.url).toBe("https://example.test/");
    expect(parsed.warnings.join("\n")).toContain("Safari unloads an idle background page about 30 s after its last event");
    expect(parsed.warnings.join("\n")).toContain("sent the automation window to https://example.test/");
    expect(parsed.warnings.join("\n")).toContain("woke: true");
  });

  it("reloads the page the window already shows when the content script matches it", async () => {
    withSession();
    reattachOnEvent();
    driver.url = "https://example.test/inbox";
    cli.replies.push(noExecutor("eval"), { code: 0, stdout: JSON.stringify(actFrame("eval", 2)), stderr: "" });

    const parsed = JSON.parse(await runActVerb(["eval", "1 + 1", project, "--context", "page", "--browser", "safari"], project, undefined, "extension_eval"));

    expect(parsed.ok).toBe(true);
    expect(parsed.value).toBe(2);
    expect(driver.calls).toContain("POST /session/S-1/refresh");
    expect(driver.calls).not.toContain("POST /session/S-1/url");
    expect(parsed.warnings.join("\n")).toContain("reloaded https://example.test/inbox in the automation window");
  });

  it("answers unavailable with the Safari sentence and woke: false when the executor never comes back", async () => {
    withSession();
    cli.replies.push(noExecutor("storage"));

    const parsed = JSON.parse(await runActVerb(["storage", "get", project, "--browser", "safari"], project, undefined, "extension_storage"));

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_CONTROL_UNAVAILABLE");
    expect(parsed.error.message).toContain("Safari unloads an idle background page about 30 s after its last event, and it comes back on the next extension event, not on its own");
    expect(parsed.error.message).toContain("its executor detached at 2026-10-22T22:05:15.448Z");
    expect(parsed.error.message).toContain("sent the automation window to https://example.test/");
    expect(parsed.error.message).toContain("had not attached again 400 ms later");
    expect(parsed.error.message).toContain("woke: false");
    expect(parsed.error.message).not.toContain("MV3 workers idle out");
    expect(parsed.error.message).not.toContain("reconnect on their own");
    expect(parsed.value).toMatchObject({ browser: "safari", woke: false });
    expect(parsed.hint).toContain("extension_open url");
    expect(parsed.hint).toContain('extension_eval context "page"');
    expect(cli.calls).toHaveLength(1);
    expect(driver.calls).toContain("POST /session/S-1/url");
  });

  it("says it had no window to send an event through when ready.json records no safaridriver session", async () => {
    writeContract("safari", safariDevContract({ unavailableReason: "the WebDriver session request failed: timed out" }, DETACHED));
    cli.replies.push(noExecutor("storage"));

    const parsed = JSON.parse(
      await storageTool.handler({ projectPath: project, browser: "safari", action: "get" }),
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe("extension_storage");
    expect(parsed.error.message).toContain("Safari unloads an idle background page about 30 s after its last event");
    expect(parsed.error.message).toContain("records no safaridriver session for this run, so this server has no window to send the extension an event through");
    expect(parsed.error.message).toContain("woke: false");
    expect(parsed.error.message).not.toContain("MV3 workers idle out");
    expect(parsed.value).toMatchObject({ woke: false });
    expect(cli.calls).toHaveLength(1);
    expect(driver.calls).toHaveLength(0);
  });

  it("leaves a Chromium session's answer as the engine wrote it", async () => {
    writeContract("chrome", { ...safariDevContract({ unavailableReason: "n/a" }), browser: "chrome", ...DETACHED });
    cli.replies.push(noExecutor("storage"));

    const parsed = JSON.parse(await runActVerb(["storage", "get", project, "--browser", "chrome"], project, undefined, "extension_storage"));

    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toContain("MV3 workers idle out and reconnect on their own");
    expect(parsed.error.message).not.toContain("Safari unloads");
    expect(cli.calls).toHaveLength(1);
  });
});

describe("the wake destination comes from the content script matches", () => {
  it("turns a match pattern into one address the window can be sent to", () => {
    expect(wakeUrlFromMatchPattern("https://example.test/*")).toBe("https://example.test/");
    expect(wakeUrlFromMatchPattern("*://*.mail.test/inbox/*")).toBe("https://mail.test/inbox/");
    expect(wakeUrlFromMatchPattern("http://127.0.0.1:8765/*")).toBe("http://127.0.0.1:8765/");
    expect(wakeUrlFromMatchPattern("*://*/*")).toBeNull();
    expect(wakeUrlFromMatchPattern("<all_urls>")).toBeNull();
    expect(wakeUrlFromMatchPattern("file:///*")).toBeNull();
  });

  it("reloads a matching page the window shows, otherwise navigates, and gives up without a match", () => {
    expect(wakePlan(["https://example.test/*"], "https://example.test/a")).toEqual({ action: "refresh", url: "https://example.test/a" });
    expect(wakePlan(["<all_urls>"], "https://any.test/")).toEqual({ action: "refresh", url: "https://any.test/" });
    expect(wakePlan(["https://example.test/*"], "about:blank")).toEqual({ action: "navigate", url: "https://example.test/" });
    expect(wakePlan(["https://example.test/*"], "https://other.test/")).toEqual({ action: "navigate", url: "https://example.test/" });
    expect(wakePlan(["<all_urls>"], "about:blank")).toEqual({ action: "navigate", url: "https://example.com/" });
    expect(wakePlan([], "https://any.test/")).toBeNull();
    expect(wakePlan(["*://*/*"], "about:blank")).toBeNull();
  });
});
