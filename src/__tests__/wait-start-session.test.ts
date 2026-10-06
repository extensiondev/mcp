import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as wait from "../tools/wait";
import { deadReadySession } from "../lib/session-browser";

const dirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wait-start-"));
  dirs.push(dir);
  return dir;
}

function writeContract(projectPath: string, browser: string, contract: Record<string, unknown>): void {
  const dir = path.join(projectPath, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ready.json"),
    JSON.stringify({ schema: 1, status: "ready", browser, ts: new Date().toISOString(), ...contract }),
  );
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_wait on a start session says at once that nothing will attach", () => {
  it("answers launched with the production-build guidance instead of burning the budget on E_NOT_ATTACHED", async () => {
    const project = tmpProject();
    writeContract(project, "chrome", {
      command: "start",
      pid: process.pid,
      port: 8080,
      compiledAt: new Date().toISOString(),
    });
    const started = Date.now();

    const result = JSON.parse(
      await wait.handler({ projectPath: project, browser: "chrome", timeoutMs: 90_000 }),
    );

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("launched");
    expect(result.value).toMatchObject({ compiled: true, browserAttached: false, sessionCommand: "start" });
    expect(result.hint).toContain("extension_start session");
    expect(result.hint).toContain("Do not call extension_wait again");
    expect(result.hint).toContain("extension_build");
    expect(result.warnings.join(" ")).toContain("clamped to 50000ms");
  }, 20_000);

  it("answers launched for a preview session too, which the engine stamps as command preview", async () => {
    const project = tmpProject();
    writeContract(project, "chrome", {
      command: "preview",
      pid: process.pid,
      port: null,
      compiledAt: new Date().toISOString(),
    });
    const started = Date.now();

    const result = JSON.parse(
      await wait.handler({ projectPath: project, browser: "chrome", timeoutMs: 1500 }),
    );

    expect(Date.now() - started).toBeLessThan(1400);
    expect(result.status).toBe("launched");
    expect(result.value.sessionCommand).toBe("preview");
    expect(result.hint).toContain("prebuilt dist");
  }, 10_000);

  it("keeps waiting on a dev session that has compiled but not attached, and says when the budget was clamped", async () => {
    const project = tmpProject();
    writeContract(project, "chrome", {
      command: "dev",
      pid: process.pid,
      port: 8080,
      compiledAt: new Date().toISOString(),
    });

    const result = JSON.parse(
      await wait.handler({ projectPath: project, browser: "chrome", timeoutMs: 1_000 }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NOT_ATTACHED");
    expect(result.warnings.join(" ")).not.toContain("clamped");
  }, 15_000);
});

describe("a dead contract explains only the browser the call named", () => {
  it("does not blame a chrome call on firefox's stale contract", () => {
    const project = tmpProject();
    writeContract(project, "chrome", { command: "dev", pid: process.pid });
    writeContract(project, "firefox", { command: "dev", pid: 999_999_999 });

    expect(deadReadySession(project, "chrome")).toBeNull();
    expect(deadReadySession(project, "firefox")).toMatchObject({ browser: "firefox", pid: 999_999_999 });
    expect(deadReadySession(project)).toMatchObject({ browser: "firefox" });
  });
});
