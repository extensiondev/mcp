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
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChildProcess } from "node:child_process";
import type * as ExecModule from "../lib/exec";
import type { SpawnedCli } from "../lib/exec";
import type * as WaitModule from "../tools/wait";
import type * as LogsModule from "../tools/logs";

const spawned: ChildProcess[] = [];
const STARTING_URL = "http://127.0.0.1:8766/call.html";

function fakeCli(): SpawnedCli {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-cli-"));
  const logPath = path.join(logDir, "session.log");
  fs.writeFileSync(logPath, "");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  spawned.push(child);

  return { child, logPath, readOutput: () => "" };
}

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return { ...actual, spawnExtensionCli: () => fakeCli() };
});

vi.mock("../tools/wait", async (importOriginal) => {
  const actual = await importOriginal<typeof WaitModule>();

  return {
    ...actual,
    handler: async () =>
      JSON.stringify({ ok: true, status: "ready", value: { compiled: true, browserAttached: true, guestLoaded: null } }),
  };
});

vi.mock("../tools/logs", async (importOriginal) => {
  const actual = await importOriginal<typeof LogsModule>();

  return {
    ...actual,
    handler: async () => JSON.stringify({ ok: true, status: "ok", value: { count: 0, lines: [] } }),
  };
});

const dev = await import("../tools/dev");
const { removeSession, removeSessionMarker } = await import("../lib/process-manager");
const { readyContractPath } = await import("../lib/session-paths");

const tmpDirs: string[] = [];

function tmpProject(browser: string, contract: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-safari-url-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ name: "Hands-free", version: "0.1.0" }));
  const file = readyContractPath(dir, browser);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ status: "ready", browser, command: "dev", runId: "run-1", ...contract }));

  return dir;
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  for (const dir of tmpDirs.splice(0)) {
    for (const browser of ["chrome", "safari"]) {
      try {
        removeSession(dir, browser);
        removeSessionMarker(dir, browser);
      } catch {
      }
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function start(project: string, browser = "safari"): Promise<{ status: string; warnings: string[] }> {
  return JSON.parse(await dev.handler({ projectPath: project, browser, startingUrl: STARTING_URL } as never));
}

const urlLine = (warnings: string[]) => warnings.find((line) => line.includes(`startingUrl ${STARTING_URL}`));

describe("extension_dev on Safari says whether startingUrl opened", () => {
  it("says nothing when the engine recorded that it opened the page", async () => {
    const result = await start(tmpProject("safari", { startingUrl: STARTING_URL, startingUrlOpened: true }));

    expect(result.status).toBe("started");
    expect(urlLine(result.warnings)).toBeUndefined();
  }, 15_000);

  it("carries the engine's reason when the page was not opened", async () => {
    const result = await start(
      tmpProject("safari", {
        startingUrl: STARTING_URL,
        startingUrlOpened: false,
        startingUrlUnopenedReason: "Safari opens it in the automation window, and this run holds no WebDriver session (timed out)",
      }),
    );

    const line = urlLine(result.warnings);
    expect(line).toContain(`Safari did not open startingUrl ${STARTING_URL}: Safari opens it in the automation window`);
    expect(line).toContain("Open it with extension_open url");
  }, 15_000);

  it("does not claim the page opened when the engine recorded no outcome", async () => {
    const result = await start(tmpProject("safari", {}));

    expect(urlLine(result.warnings)).toContain("ready.json records no outcome");
  }, 15_000);

  it("adds nothing for a Chromium session", async () => {
    const result = await start(tmpProject("chrome", {}), "chrome");

    expect(urlLine(result.warnings)).toBeUndefined();
  }, 15_000);
});
