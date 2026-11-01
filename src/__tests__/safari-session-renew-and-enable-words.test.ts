import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { wakeSafariBackground } from "../lib/safari-background";
import { notAttachedHint } from "../lib/safari-dev-options";
import { parseSafariEngineSays } from "../lib/safari-enable-log";
import { readyContractPath } from "../lib/session-paths";
import { safariDevContract } from "./fixtures/engine-answers";

const DETACHED = {
  executorAttachedAt: "2026-10-31T22:00:13.226Z",
  executorDetachedAt: "2026-10-31T22:05:15.448Z",
  runtime: "detached",
};

interface FakeDriver {
  port: number;
  calls: string[];
  close(): Promise<void>;
}

async function startFakeDriver(onNavigate: () => void): Promise<FakeDriver> {
  const state: FakeDriver = { port: 0, calls: [], close: async () => {} };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const route = `${req.method} ${req.url}`;
      state.calls.push(route);
      res.writeHead(200, { "content-type": "application/json" });

      if (route === "GET /session/S-2/url") return res.end(JSON.stringify({ value: "about:blank" }));

      if (route === "POST /session/S-2/url") onNavigate();

      res.end(JSON.stringify({ value: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  state.port = typeof address === "object" && address ? address.port : 0;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));

  return state;
}

describe("a Safari wake with no WebDriver window asks the dev run for a new one", () => {
  let project: string;
  let contractFile: string;
  let requestFile: string;
  let driver: FakeDriver;
  let engine: ReturnType<typeof setInterval> | null = null;

  function contract(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(contractFile, "utf8")) as Record<string, unknown>;
  }

  function write(body: Record<string, unknown>): void {
    fs.writeFileSync(contractFile, JSON.stringify(body));
  }

  beforeEach(async () => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-safari-renew-"));
    contractFile = readyContractPath(project, "safari");
    requestFile = path.join(path.dirname(contractFile), "webdriver-request.json");
    fs.mkdirSync(path.dirname(contractFile), { recursive: true });
    const dist = path.join(project, "dist", "safari");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "manifest.json"),
      JSON.stringify({ name: "Hands-free", manifest_version: 3, content_scripts: [{ matches: ["https://example.test/*"], js: ["content.js"] }] }),
    );

    driver = await startFakeDriver(() => write({ ...contract(), runtime: "attached", executorAttachedAt: new Date().toISOString() }));
  });

  afterEach(async () => {
    if (engine) clearInterval(engine);

    engine = null;
    await driver.close();
    fs.rmSync(project, { recursive: true, force: true });
  });

  function engineAnswers(answer: () => Record<string, unknown>): void {
    engine = setInterval(() => {
      if (!fs.existsSync(requestFile)) return;

      fs.rmSync(requestFile);
      write({ ...contract(), webdriverUnavailableReason: "the launcher is asking safaridriver for a session now: each request waits up to 30 s" });
      setTimeout(() => {
        const next = { ...contract(), ...answer() };
        if ("webdriverPort" in next) delete next.webdriverUnavailableReason;

        write(next);
      }, 150);
    }, 50);
  }

  it("writes the request, attaches to the new session and wakes the background through it", async () => {
    write(safariDevContract({ unavailableReason: "the WebDriver session request failed: timed out" }, { ...DETACHED, webdriverRequestPath: requestFile }));
    engineAnswers(() => ({ webdriverPort: driver.port, webdriverSessionId: "S-2" }));

    const wake = await wakeSafariBackground(project, "safari", 2_000, 5_000);

    expect(wake.woke).toBe(true);
    expect(wake.how).toContain(`asked the dev run for a new WebDriver session and got S-2 on port ${driver.port}`);
    expect(driver.calls).toContain("POST /session/S-2/url");
    expect(fs.existsSync(requestFile)).toBe(false);
  });

  it("names the reason the dev run opened none instead of a bare timeout", async () => {
    write(safariDevContract({ unavailableReason: "old reason" }, { ...DETACHED, webdriverRequestPath: requestFile }));
    engineAnswers(() => ({ webdriverUnavailableReason: "the WebDriver session request failed: Safari already runs an automation instance from another WebDriver session (pid 77)" }));

    const wake = await wakeSafariBackground(project, "safari", 2_000, 5_000);

    expect(wake.woke).toBe(false);
    expect(wake.how).toBe(
      "ready.json records no safaridriver session for this run, so this server has no window to send the extension an event through; it asked the dev run for a new WebDriver session and it opened none: the WebDriver session request failed: Safari already runs an automation instance from another WebDriver session (pid 77)",
    );

    expect(driver.calls).toHaveLength(0);
  });

  it("says when the engine cannot open a session on request", async () => {
    write(safariDevContract({ unavailableReason: "the WebDriver session request failed: timed out" }, DETACHED));

    const wake = await wakeSafariBackground(project, "safari", 2_000, 5_000);

    expect(wake.how).toContain("ready.json names no webdriverRequestPath, so this engine cannot open a new WebDriver session on request");
    expect(fs.existsSync(requestFile)).toBe(false);
  });
});

describe("a Safari enable that failed answers with the engine's own line", () => {
  const LOG = [
    "\u001b[33m►►►\u001b[0m Safari unsigned extensions: read off → off.",
    "\u001b[33m►►►\u001b[0m Couldn't finish enabling \u001b[33mRebeccat\u001b[0m in Safari: Safari Settings did not switch to Extensions: a sheet is open on Safari Settings and waits for an answer",
    "Finish the steps below by hand.",
    "►►► No WebDriver session for this run: the WebDriver session request failed: safaridriver did not answer the session request within 30 s",
  ].join("\n");

  it("reads the enable and WebDriver lines with no color codes", () => {
    expect(parseSafariEngineSays(LOG)).toEqual({
      accessibility: false,
      lines: [
        "Couldn't finish enabling Rebeccat in Safari: Safari Settings did not switch to Extensions: a sheet is open on Safari Settings and waits for an answer",
        "No WebDriver session for this run: the WebDriver session request failed: safaridriver did not answer the session request within 30 s",
      ],
    });
  });

  it("leads with what the engine logged and drops the stock Accessibility hint", () => {
    const hint = notAttachedHint("safari", true, parseSafariEngineSays(LOG));

    expect(hint).toMatch(/^The extension is not enabled in Safari yet\. The engine logged why: Couldn't finish enabling Rebeccat in Safari: Safari Settings did not switch to Extensions/);
    expect(hint).toContain("No WebDriver session for this run:");
    expect(hint).not.toContain("Accessibility");
  });

  it("keeps the Accessibility words when the engine named a missing grant", () => {
    const says = parseSafariEngineSays("Can't drive Safari's settings without an Accessibility grant for Cursor.\nOpen System Settings");

    expect(says.accessibility).toBe(true);
    expect(notAttachedHint("safari", true, says)).toContain("Grant Accessibility to the terminal app that runs this server");
  });
});
