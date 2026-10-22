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

import { describe, it, expect, vi, afterEach } from "vitest";

import type { ChildProcess } from "node:child_process";
import type * as ExecModule from "../lib/exec";
import type { SpawnedCli } from "../lib/exec";
import type * as WaitModule from "../tools/wait";
import type * as LogsModule from "../tools/logs";

const spawned: ChildProcess[] = [];
const cliArgsSeen: string[][] = [];

function fakeCli(): SpawnedCli {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-cli-"));
  const logPath = path.join(logDir, "session.log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  spawned.push(child);

  return {
    child,
    logPath,
    readOutput: () => {
      try {
        return fs.readFileSync(logPath, "utf8");
      } catch {
        return "";
      }
    },
  };
}

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    spawnExtensionCli: (args: string[]) => {
      cliArgsSeen.push(args);

      return fakeCli();
    },
  };
});

let waitAnswer = (): string =>
  JSON.stringify({ ok: true, status: "ready", value: { compiled: true, browserAttached: true, guestLoaded: true } });

vi.mock("../tools/wait", async (importOriginal) => {
  const actual = await importOriginal<typeof WaitModule>();

  return {
    ...actual,
    handler: async () => waitAnswer(),
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
const { findSessionInfo, removeSession, removeSessionMarker } = await import("../lib/process-manager");

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-safari-"));
  tmpDirs.push(dir);

  return dir;
}

afterEach(() => {
  cliArgsSeen.length = 0;
  waitAnswer = () =>
    JSON.stringify({ ok: true, status: "ready", value: { compiled: true, browserAttached: true, guestLoaded: true } });

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

describe("extension_dev carries the Safari options extension_build already has, plus enableExtension", () => {
  it("documents every Safari option in the input schema, each marked Safari-only", () => {
    const properties = dev.schema.inputSchema.properties as unknown as Record<string, { description: string }>;

    for (const name of ["appName", "bundleId", "developmentTeam", "macOsOnly", "forceRegenerate", "enableExtension"]) {
      expect(properties[name]?.description, name).toMatch(/^Safari targets only/);
    }

    expect(properties.enableExtension!.description).toContain("Accessibility");
    expect(properties.enableExtension!.description).toContain("compiled-not-attached");
  });

  it("passes the engine's own flag names through, in the engine's spelling", async () => {
    const project = tmpProject();

    const result = JSON.parse(
      await dev.handler({
        wait: false,
        projectPath: project,
        browser: "safari",
        appName: "Leon",
        bundleId: "com.acme.leon",
        developmentTeam: "ABCDE12345",
        macOsOnly: false,
        forceRegenerate: true,
        enableExtension: true,
      }),
    );

    expect(result.status).toBe("started");
    expect(cliArgsSeen[0]!.slice(0, 4)).toEqual(["dev", project, "--browser", "safari"]);
    expect(cliArgsSeen[0]!.join(" ")).toContain(
      "--app-name Leon --bundle-id com.acme.leon --development-team ABCDE12345 --macos-only false --force-regenerate --enable-extension",
    );

    expect(findSessionInfo(project, "safari")?.enableExtension).toBe(true);
  }, 15_000);

  it("passes no Safari flag and records no enable request on a plain Safari call", async () => {
    const project = tmpProject();

    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project, browser: "safari" }));

    expect(result.status).toBe("started");
    expect(cliArgsSeen[0]!.join(" ")).not.toMatch(/--enable-extension|--app-name|--bundle-id|--development-team|--macos-only|--force-regenerate/);
    expect(findSessionInfo(project, "safari")?.enableExtension).toBeUndefined();
  }, 15_000);

  it("refuses a Safari option for another browser before anything is spawned", async () => {
    const project = tmpProject();

    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project, enableExtension: true, bundleId: "com.acme.leon" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("safari-only-option");
    expect(result.error.code).toBe("E_SAFARI_ONLY_OPTION");
    expect(result.value.options).toEqual(["bundleId", "enableExtension"]);
    expect(result.error.message).toContain("chrome session");
    expect(cliArgsSeen).toHaveLength(0);
  });

  it("refuses a bundle id the engine would reject before anything is spawned", async () => {
    const project = tmpProject();

    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project, browser: "safari", bundleId: "a..b" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("invalid-bundle-id");
    expect(result.error.code).toBe("E_INVALID_BUNDLE_ID");
    expect(cliArgsSeen).toHaveLength(0);
  });

  it("says the extension is not enabled in Safari yet when the wait answers compiled-not-attached", async () => {
    const project = tmpProject();

    waitAnswer = () =>
      JSON.stringify({ ok: false, status: "compiled-not-attached", value: { compiled: true, browserAttached: false } });

    const result = JSON.parse(await dev.handler({ projectPath: project, browser: "safari" }));

    expect(result.status).toBe("started");
    expect(result.value.ready.status).toBe("compiled-not-attached");
    expect(result.hint).toContain("The extension is not enabled in Safari yet");
    expect(result.hint).toContain("enableExtension: true");
    expect(result.hint).toContain("Safari > Settings > Extensions");
    expect(result.hint).not.toContain("call extension_wait to keep waiting on the same contract");
  }, 15_000);

  it("keeps the generic wait advice for a Chromium session that answers compiled-not-attached", async () => {
    const project = tmpProject();

    waitAnswer = () =>
      JSON.stringify({ ok: false, status: "compiled-not-attached", value: { compiled: true, browserAttached: false } });

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.status).toBe("started");
    expect(result.hint).toContain("call extension_wait to keep waiting on the same contract");
    expect(result.hint).not.toContain("not enabled in Safari");
  }, 15_000);
});
