// Swarm cluster 16: extension_wait blocked up to 45s with zero narration, a
// budget learnable only by paying it, and one conflated "ready" that mixed
// compiler-ready with browser-alive. These tests pin the narrated contract:
// every result carries budgetMs + elapsedMs, timeouts say what WAS observed,
// build-only sessions return at compile time, and compiled/browserAttached are
// separate facts. Fixture contracts stand in for live sessions throughout.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handler, schema } from "../tools/wait";
import {
  registerSession,
  removeSession,
  removeSessionMarker,
} from "../lib/process-manager";
import { writeModernContract } from "./fixtures/ready-contract";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wait-narration-"));
});
afterEach(() => {
  removeSession(dir, "chrome");
  removeSessionMarker(dir, "chrome");
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_wait budget disclosure", () => {
  it("documents timeoutMs with its default and clamp bounds in the schema", () => {
    const timeoutMs = schema.inputSchema.properties.timeoutMs;
    expect(timeoutMs.default).toBe(45000);
    expect(timeoutMs.description).toContain("45000");
    expect(timeoutMs.description).toContain("1000-50000");
    // The legacy spelling stays accepted and says so.
    expect(schema.inputSchema.properties.timeout.description).toContain(
      "timeoutMs",
    );
  });

  it("narrates a timeout: budget, elapsed, and what was observed", async () => {
    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", timeoutMs: 1200 }),
    );

    expect(result.status).toBe("timeout");
    expect(result.budgetMs).toBe(1200);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1200);
    expect(result.compiled).toBe(false);
    expect(result.browserAttached).toBe(false);
    expect(result.message).toContain("no ready contract");
    expect(result.hint).toContain("call extension_wait again");
  }, 10_000);

  it("accepts the legacy timeout alias, with timeoutMs winning when both are given", async () => {
    const aliased = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", timeout: 1100 }),
    );
    expect(aliased.budgetMs).toBe(1100);

    const both = JSON.parse(
      await handler({
        projectPath: dir,
        browser: "chrome",
        timeoutMs: 1300,
        timeout: 9999,
      }),
    );
    expect(both.budgetMs).toBe(1300);
  }, 10_000);

  it("says the compile has not landed when only a starting stamp was seen", async () => {
    writeModernContract(dir, "chrome", {
      status: "starting",
      pid: process.pid,
    });

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", timeoutMs: 1200 }),
    );

    expect(result.status).toBe("timeout");
    expect(result.compiled).toBe(false);
    expect(result.message).toContain("starting");
  }, 10_000);
});

describe("extension_wait splits compiled from browserAttached", () => {
  it("reports both facts true on a compiled and attached session", async () => {
    writeModernContract(dir, "chrome", {
      port: 8083,
      pid: process.pid,
      runtime: "attached",
      executorAttachedAt: new Date().toISOString(),
    });

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome" }),
    );

    expect(result.status).toBe("ready");
    expect(result.compiled).toBe(true);
    expect(result.browserAttached).toBe(true);
    // The port comes from the contract, the same source extension_dev reports.
    expect(result.port).toBe(8083);
    expect(result.budgetMs).toBe(45000);
    expect(typeof result.elapsedMs).toBe("number");
  });

  it("keeps the half-ready state separate when the budget runs out unattached", async () => {
    writeModernContract(dir, "chrome", { pid: process.pid });

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }),
    );

    expect(result.status).toBe("compiled-not-attached");
    expect(result.compiled).toBe(true);
    expect(result.browserAttached).toBe(false);
    expect(result.budgetMs).toBe(1500);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1500);
  }, 10_000);
});

describe("extension_wait in build-only sessions", () => {
  it("returns at compile time instead of waiting for a browser that cannot attach", async () => {
    registerSession({
      pid: process.pid,
      browser: "chrome",
      projectPath: dir,
      command: "dev",
      noBrowser: true,
    });
    writeModernContract(dir, "chrome", { pid: process.pid });

    const before = Date.now();
    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome" }),
    );

    expect(result.status).toBe("ready");
    expect(result.buildOnly).toBe(true);
    expect(result.compiled).toBe(true);
    expect(result.browserAttached).toBe(false);
    expect(result.message).toContain("no browser was launched");
    // Immediate, not a 45s stall against an attach that cannot happen.
    expect(Date.now() - before).toBeLessThan(5_000);
  });

  it("still knows a session is build-only through its on-disk marker alone", async () => {
    registerSession({
      pid: process.pid,
      browser: "chrome",
      projectPath: dir,
      command: "dev",
      noBrowser: true,
    });
    // A fresh MCP process has no in-memory registry; only the marker survives.
    removeSession(dir, "chrome");
    writeModernContract(dir, "chrome", { pid: process.pid });

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome" }),
    );

    expect(result.status).toBe("ready");
    expect(result.buildOnly).toBe(true);
    expect(result.browserAttached).toBe(false);
  });
});
