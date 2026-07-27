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
    expect(schema.inputSchema.properties.timeout.description).toContain(
      "timeoutMs",
    );
  });

  it("narrates a timeout: budget, elapsed, and what was observed", async () => {
    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", timeoutMs: 1200 }),
    );

    expect(result.schema).toBe(1);
    expect(result.command).toBe("extension_wait");
    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.error.code).toBe("E_WAIT_TIMEOUT");
    expect(result.value.budgetMs).toBe(1200);
    expect(result.value.elapsedMs).toBeGreaterThanOrEqual(1200);
    expect(result.value.compiled).toBe(false);
    expect(result.value.browserAttached).toBe(false);
    expect(result.error.message).toContain("no ready contract");
    expect(result.hint).toContain("call extension_wait again");
  }, 10_000);

  it("accepts the legacy timeout alias, with timeoutMs winning when both are given", async () => {
    const aliased = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", timeout: 1100 }),
    );
    expect(aliased.value.budgetMs).toBe(1100);

    const both = JSON.parse(
      await handler({
        projectPath: dir,
        browser: "chrome",
        timeoutMs: 1300,
        timeout: 9999,
      }),
    );
    expect(both.value.budgetMs).toBe(1300);
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
    expect(result.value.compiled).toBe(false);
    expect(result.error.message).toContain("starting");
  }, 10_000);
});

describe("extension_wait ignores contracts from a previous run", () => {
  function backdate(file: string, ms: number): void {
    const past = new Date(Date.now() - ms);
    fs.utimesSync(file, past, past);
  }

  it("does not report the previous run's compile error against a booting session", async () => {
    const file = writeModernContract(dir, "chrome", {
      status: "error",
      message: "old compile failed",
      errors: ["stale error"],
      pid: process.pid,
    });
    backdate(file, 60_000);
    registerSession({
      pid: process.pid,
      browser: "chrome",
      projectPath: dir,
      command: "dev",
    });

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", timeoutMs: 1200 }),
    );

    expect(result.status).not.toBe("contract-error");
    expect(result.status).toBe("timeout");
    expect(result.warnings.join(" ")).toContain("previous run");
  }, 10_000);

  it("does not call a healthy booting session stale over a dead leftover ready stamp", async () => {
    const file = writeModernContract(dir, "chrome", {
      status: "ready",
      pid: 2 ** 30,
    });
    backdate(file, 60_000);
    registerSession({
      pid: process.pid,
      browser: "chrome",
      projectPath: dir,
      command: "dev",
    });

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", timeoutMs: 1200 }),
    );

    expect(result.error?.code).not.toBe("E_STALE_CONTRACT");
    expect(result.status).toBe("timeout");
  }, 10_000);

  it("does not trust an error stamp whose dev-server pid is dead when no session is known", async () => {
    writeModernContract(dir, "chrome", {
      status: "error",
      message: "compile failed long ago",
      pid: 2 ** 30,
    });

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", timeoutMs: 1200 }),
    );

    expect(result.status).not.toBe("contract-error");
    expect(result.status).toBe("timeout");
    expect(result.warnings.join(" ")).toContain("dead");
  }, 10_000);

  it("still reports a fresh compile error from the live session", async () => {
    registerSession({
      pid: process.pid,
      browser: "chrome",
      projectPath: dir,
      command: "dev",
    });
    writeModernContract(dir, "chrome", {
      status: "error",
      message: "fresh compile failed",
      errors: ["broken import"],
      pid: process.pid,
    });

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", timeoutMs: 2000 }),
    );

    expect(result.status).toBe("contract-error");
    expect(result.error.message).toContain("fresh compile failed");
  }, 10_000);
});

describe("extension_wait splits compiled from browserAttached", () => {
  it("reports both facts true, renaming the contract's own command to sessionCommand since the envelope owns the command key", async () => {
    writeModernContract(dir, "chrome", {
      command: "dev",
      port: 8083,
      pid: process.pid,
      runtime: "attached",
      executorAttachedAt: new Date().toISOString(),
    });

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome" }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ready");
    expect(result.value.compiled).toBe(true);
    expect(result.value.browserAttached).toBe(true);
    expect(result.value.port).toBe(8083);
    expect(result.value.budgetMs).toBe(45000);
    expect(typeof result.value.elapsedMs).toBe("number");
    expect(result.command).toBe("extension_wait");
    expect(result.value.sessionCommand).toBe("dev");
  });

  it("keeps the half-ready state separate when the budget runs out unattached", async () => {
    writeModernContract(dir, "chrome", { pid: process.pid });

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("compiled-not-attached");
    expect(result.error.code).toBe("E_NOT_ATTACHED");
    expect(result.value.compiled).toBe(true);
    expect(result.value.browserAttached).toBe(false);
    expect(result.value.budgetMs).toBe(1500);
    expect(result.value.elapsedMs).toBeGreaterThanOrEqual(1500);
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
    expect(result.value.buildOnly).toBe(true);
    expect(result.value.compiled).toBe(true);
    expect(result.value.browserAttached).toBe(false);
    expect(result.hint).toContain("no browser was launched");
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
    removeSession(dir, "chrome");
    writeModernContract(dir, "chrome", { pid: process.pid });

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome" }),
    );

    expect(result.status).toBe("ready");
    expect(result.value.buildOnly).toBe(true);
    expect(result.value.browserAttached).toBe(false);
  });
});
