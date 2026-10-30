import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, it, expect, vi, afterEach } from "vitest";

import { controlledCopyPath, registeredExtensionId } from "../lib/controlled-identity";

import type { ChildProcess } from "node:child_process";
import type * as ExecModule from "../lib/exec";
import type { SpawnedCli } from "../lib/exec";

const spawned: ChildProcess[] = [];
const spawnedArgs: string[][] = [];
const bootVerdict: { current: Record<string, unknown> } = {
  current: { kind: "started" },
};
const bootTail: { current: string } = { current: "" };

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
      spawnedArgs.push(args);

      return fakeCli();
    },
  };
});

vi.mock("../lib/boot-verdict", () => ({
  pollBootVerdict: async () => ({
    verdict: bootVerdict.current,
    warnings: [],
    evidenceTail: bootTail.current,
  }),
  bootFailureHint: () => "",
}));

const start = await import("../tools/start");
const { findSessionInfo, removeSession } = await import("../lib/process-manager");
const { noSessionWords } = await import("../lib/production-receipt");

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-start-control-"));
  tmpDirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  spawnedArgs.length = 0;
  bootVerdict.current = { kind: "started" };
  bootTail.current = "";

  for (const dir of tmpDirs.splice(0)) {
    try {
      removeSession(dir, "chrome");
    } catch {
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeContract(project: string, contract: Record<string, unknown>) {
  const dir = path.join(project, "dist", "extension-js", "chrome");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify(contract));
}

describe("extension_start opens the control channel on a production run", () => {
  it("advertises allowControl and allowEval in its schema", () => {
    const props = start.schema.inputSchema.properties as Record<string, { type?: string }>;

    expect(props.allowControl?.type).toBe("boolean");
    expect(props.allowEval?.type).toBe("boolean");
  });

  it("passes --allow-control to the engine and keeps it off by default", async () => {
    const project = tmpProject();

    await start.handler({ wait: false, projectPath: project });
    expect(spawnedArgs[0]).not.toContain("--allow-control");
    expect(spawnedArgs[0]).not.toContain("--allow-eval");

    for (const child of spawned.splice(0)) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }

    removeSession(project, "chrome");
    spawnedArgs.length = 0;

    await start.handler({ wait: false, projectPath: project, allowControl: true });
    expect(spawnedArgs[0]).toContain("--allow-control");
    expect(spawnedArgs[0]).not.toContain("--allow-eval");
  });

  it("lets allowEval imply allowControl, on preview as well as start", async () => {
    const project = tmpProject();
    const built = path.join(project, "dist", "chrome");
    fs.mkdirSync(built, { recursive: true });
    fs.writeFileSync(path.join(built, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Z" }));

    await start.handler({ wait: false, projectPath: project, build: false, allowEval: true });

    expect(spawnedArgs[0][0]).toBe("preview");
    expect(spawnedArgs[0]).toContain("--allow-control");
    expect(spawnedArgs[0]).toContain("--allow-eval");
  });

  it("reports the control port and stops saying the control verbs cannot attach", async () => {
    const project = tmpProject();
    writeContract(project, {
      command: "start",
      status: "ready",
      controlPort: 61234,
      instanceId: "inst-1",
      distPath: path.join(project, "dist", "extension-js", "chrome", "controlled"),
    });

    const before = Date.now();
    const contractFile = path.join(project, "dist", "extension-js", "chrome", "ready.json");
    fs.utimesSync(contractFile, new Date(before + 60_000), new Date(before + 60_000));

    const result = JSON.parse(
      await start.handler({ wait: false, projectPath: project, allowEval: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.allowControl).toBe(true);
    expect(result.value.allowEval).toBe(true);
    expect(result.value.controlPort).toBe(61234);
    expect(result.hint).not.toMatch(/control verbs cannot attach/);
    expect(result.hint).toMatch(/extension_eval/);
    expect(result.hint).toMatch(/extension_reload/);
  });

  it("names the controlled copy's own id beside the plain build's, rewrites a startingUrl that used the plain id, and says what the copy does not inherit", async () => {
    const project = tmpProject();
    const plainId = registeredExtensionId(path.join(project, "dist", "chrome"));
    const copyPath = controlledCopyPath(project, "chrome");
    const copyId = registeredExtensionId(copyPath);
    expect(copyPath).toBe(path.join(project, "dist", "extension-js", "chrome", "controlled"));
    writeContract(project, {
      command: "start",
      status: "ready",
      controlPort: 61234,
      instanceId: "inst-1",
      distPath: copyPath,
      extensionId: copyId,
      extensionIdSource: "browser",
    });

    const before = Date.now();
    const contractFile = path.join(project, "dist", "extension-js", "chrome", "ready.json");
    fs.utimesSync(contractFile, new Date(before + 60_000), new Date(before + 60_000));

    const result = JSON.parse(
      await start.handler({ wait: false, projectPath: project, allowEval: true, build: false, startingUrl: `chrome://extensions/?options=${plainId}` }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.buildExtensionId).toBe(plainId);
    expect(result.value.controlledCopyId).toBe(copyId);
    expect(result.value.extensionId).toBe(copyId);
    expect(result.value.extensionIdSource).toBe("browser");
    expect(copyId).not.toBe(plainId);

    const warnings = result.warnings.join("\n");
    expect(warnings).toContain(`this session's extension id is ${copyId}, not the ${plainId} that dist/<browser> gets`);
    expect(warnings).toContain("shares no chrome.storage and no grants with the plain build's runs");
    expect(warnings).toContain(`startingUrl named the plain build's id ${plainId}; it was rewritten to ${copyId}`);

    const cli = spawnedArgs[spawnedArgs.length - 1]!;
    const urlIndex = cli.indexOf("--starting-url");
    expect(urlIndex).toBeGreaterThan(-1);
    expect(cli[urlIndex + 1]).toBe(`chrome://extensions/?options=${copyId}`);
  });

  it("answers the copy's id when the contract still carries the plain build's derived id, and names two different ids", async () => {
    const project = tmpProject();
    const plainDist = path.join(project, "dist", "chrome");
    const plainId = registeredExtensionId(plainDist);
    const copyId = registeredExtensionId(controlledCopyPath(project, "chrome"));
    writeContract(project, {
      command: "start",
      status: "starting",
      distPath: plainDist,
      extensionId: plainId,
      extensionIdSource: "derived",
      browserPid: process.pid,
    });

    const contractFile = path.join(project, "dist", "extension-js", "chrome", "ready.json");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(contractFile, later, later);

    const result = JSON.parse(await start.handler({ wait: false, projectPath: project, allowControl: true, build: false }));

    expect(result.ok).toBe(true);
    expect(result.value.buildExtensionId).toBe(plainId);
    expect(result.value.controlledCopyId).toBe(copyId);
    expect(result.value.extensionId).toBe(copyId);
    expect(result.value.extensionIdSource).toBe("copy-folder");
    expect(copyId).not.toBe(plainId);

    const warnings = result.warnings.join("\n");
    expect(warnings).toContain(`this session's extension id is ${copyId}, not the ${plainId} that dist/<browser> gets`);
    expect(warnings).not.toContain(`is ${plainId}, not the ${plainId}`);
    expect(warnings).toContain(`still carried the plain build's id ${plainId}`);
  });

  it("says nothing about ids on a plain production run", async () => {
    const project = tmpProject();
    writeContract(project, { command: "start", status: "ready", instanceId: "inst-2", distPath: path.join(project, "dist", "chrome") });

    const result = JSON.parse(await start.handler({ wait: false, projectPath: project, build: false }));

    expect(result.value.buildExtensionId).toBeUndefined();
    expect(result.value.controlledCopyId).toBeUndefined();
    expect(JSON.stringify(result.warnings)).not.toContain("allowControl runs a copy");
  });

  it("says the control channel is coming while the contract has not recorded its port yet", async () => {
    const project = tmpProject();
    const shipped = path.join(project, "dist", "chrome");
    writeContract(project, { command: "start", status: "starting", distPath: shipped });

    const contractFile = path.join(project, "dist", "extension-js", "chrome", "ready.json");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(contractFile, later, later);

    const result = JSON.parse(
      await start.handler({ wait: false, projectPath: project, allowEval: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.controlPort).toBeNull();
    expect(result.value.loadEvidence).not.toMatch(/control verbs cannot attach|carries no dev bridge/);
    expect(result.hint).not.toMatch(/control verbs cannot attach|carries no dev bridge/);
    expect(result.hint).not.toContain(`copy of the build at ${shipped}`);
    expect(result.hint).toMatch(/has not recorded its port yet/);
    expect(result.hint).toMatch(/extension_wait/);
  });

  it("reads the background attaching to the control channel as the load proof", async () => {
    const { productionLaunchEvidence } = await import("../lib/production-launch");

    const attached = productionLaunchEvidence({
      command: "start",
      controlPort: 61234,
      executorAttachedAt: "2026-10-17T13:56:38.889Z",
    } as never);
    expect(attached.extensionLoaded).toBe(true);
    expect(attached.loadEvidence).toMatch(/control channel at 2026-10-17T13:56:38.889Z/);

    const waiting = productionLaunchEvidence({ command: "start", controlPort: 61234 } as never);
    expect(waiting.extensionLoaded).toBeNull();
    expect(waiting.loadEvidence).not.toMatch(/control verbs cannot attach/);

    const plain = productionLaunchEvidence({ command: "start" } as never);
    expect(plain.extensionLoaded).toBeNull();
    expect(plain.loadEvidence).toMatch(/need allowControl: true/);
  });

  it("says extension_wait reads the load over the debug port instead of claiming a production launch opens none", async () => {
    const project = tmpProject();
    writeContract(project, { command: "start", status: "starting", distPath: path.join(project, "dist", "chrome"), toolchainVersion: "4.1.36" });

    const contractFile = path.join(project, "dist", "extension-js", "chrome", "ready.json");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(contractFile, later, later);

    const result = JSON.parse(
      await start.handler({ wait: false, projectPath: project, allowControl: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.extensionLoaded).toBeNull();
    expect(result.value.loadEvidence).not.toMatch(/opens no debug port/);
    expect(result.value.loadEvidence).toMatch(/the engine \(Extension\.js 4\.1\.36\) stamps the browser's debug port \(cdpPort\) in the contract once the browser binds it, and extension_wait reads the load off that port's target list/);
    expect(result.hint).not.toMatch(/opens no debug port/);
    expect(result.hint).not.toMatch(/To prove the load, run it with extension_dev/);
    expect(result.hint).toContain(`Call extension_wait {projectPath: ${JSON.stringify(project)}, browser: "chrome"}: it reads the load over the browser's debug port once the contract names it (cdpPort).`);
  });

  it("records allowControl in the session registry, so a still-starting receipt knows control was asked for", async () => {
    const project = tmpProject();
    writeContract(project, { command: "start", status: "starting", distPath: path.join(project, "dist", "chrome"), controlPort: null });

    const contractFile = path.join(project, "dist", "extension-js", "chrome", "ready.json");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(contractFile, later, later);

    const result = JSON.parse(await start.handler({ wait: false, projectPath: project, allowControl: true }));

    expect(result.ok).toBe(true);
    expect(findSessionInfo(project, "chrome")?.allowControl).toBe(true);

    const words = noSessionWords(project, "chrome", { message: "dev words" });

    expect(words.hint).not.toMatch(/without allowControl/);
    expect(words.hint).toMatch(/This run asked for the control channel \(allowControl: true in this server's session registry\)/);
  });

  it("keeps extension_dev as the proof on an engine older than 4.1.34, and says which engine that is", async () => {
    const project = tmpProject();
    writeContract(project, { command: "start", status: "starting", distPath: path.join(project, "dist", "chrome"), toolchainVersion: "4.1.33" });

    const contractFile = path.join(project, "dist", "extension-js", "chrome", "ready.json");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(contractFile, later, later);

    const result = JSON.parse(await start.handler({ wait: false, projectPath: project }));

    expect(result.value.loadEvidence).toMatch(/this engine \(Extension\.js 4\.1\.33\) opens no debug port on a production run \(4\.1\.34 is the first that does\)/);
    expect(result.hint).toMatch(/To prove the load, run it with extension_dev, whose answer carries guestLoaded\./);
  });

  it("refuses with the engine it needs when the engine has no control flags", async () => {
    const project = tmpProject();
    bootVerdict.current = { kind: "exited", exitCode: 1, signal: null };
    bootTail.current = "error: unknown option '--allow-control'\n";

    const result = JSON.parse(
      await start.handler({ wait: false, projectPath: project, allowControl: true }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("engine-unsupported");
    expect(result.error.code).toBe("E_ENGINE_TOO_OLD");
    expect(result.error.message).toMatch(/--allow-control/);
    expect(result.error.message).toMatch(/4\.1\.33/);
    expect(result.hint).toMatch(/extension_dev/);
  });
});
