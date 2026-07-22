import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

// Stand in for the extension CLI: `node -e <script>` gives a real child process
// with real exit semantics, so the health tick is exercised end to end rather
// than against a hand-rolled EventEmitter. Mirrors the real spawnExtensionCli
// contract: output goes to a log file, not pipes (the detach-outlives-stdio
// design), and the handle exposes readOutput().
type SpawnedCli = import("../lib/exec").SpawnedCli;
const spawned: ChildProcess[] = [];
function fakeCli(script: string): SpawnedCli {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-cli-"));
  const logPath = path.join(logDir, "session.log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, ["-e", script], {
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

let nextChild: () => SpawnedCli = () => fakeCli("setTimeout(()=>{}, 60000)");

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    spawnExtensionCli: () => nextChild(),
  };
});

const dev = await import("../tools/dev");
const start = await import("../tools/start");
const wait = await import("../tools/wait");
const { removeSession } = await import("../lib/process-manager");
const { writeModernContract } = await import("./fixtures/ready-contract");

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-health-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      removeSession(dir, "chrome");
    } catch {
      // no session registered
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_dev health tick", () => {
  it("reports the death instead of status:started when the server exits on boot", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli(
        'console.error("Error: listen EADDRINUSE: address already in use :::8080"); process.exit(1);',
      );

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("exited");
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("exited during startup");
    // The child's own output is the evidence a caller needs to fix it.
    expect(result.output).toContain("EADDRINUSE");
  }, 15_000);

  it("surfaces a signalled death", async () => {
    const project = tmpProject();
    nextChild = () => fakeCli("process.kill(process.pid, 'SIGKILL')");

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("exited");
    expect(result.signal).toBe("SIGKILL");
  }, 15_000);

  // extension_start had the identical defect, found by sweeping for the pattern
  // after the dev.ts fix rather than by hitting it.
  it("applies to extension_start too", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli('console.error("build failed: missing dependency"); process.exit(1);');

    const result = JSON.parse(await start.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("exited");
    expect(result.output).toContain("build failed");
  }, 20_000);

  // L5 from the API-surface swarm: a FAILED FIRST COMPILE leaves the dev server
  // alive, so the process health tick cannot see it. Three personas were told
  // status:"started" with the error buried in earlyOutput.
  it("reports a failed first compile even though the server is alive", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli(
        'console.log("\\u2716\\u2716\\u2716 Probe compiled with errors in 180 ms. ERROR in ./src/panel.js NOT FOUND"); setTimeout(()=>{}, 60000);',
      );

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("compile-failed");
    expect(result.output).toContain("compiled with errors");
    expect(result.hint).toContain("extension_wait");
  }, 20_000);

  it("still reports started for a server that survives the tick", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli('console.log("ready in 300ms"); setTimeout(()=>{}, 60000);');

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("started");
    expect(result.browser).toBe("chrome");
    expect(result.earlyOutput).toContain("ready in 300ms");
  }, 15_000);
});

// Swarm cluster 19, the most-corroborated finding (8 of 10 personas): dev said
// port: 8080 while wait said 8081 for the same session, because dev echoed the
// REQUESTED port back instead of the one the engine actually bound. The engine
// records the bound port in ready.json from its first stamp, so that contract
// is the single source of truth for both tools.
describe("extension_dev port truth", () => {
  it("reports the bound port from ready.json and never disagrees with wait", async () => {
    const project = tmpProject();
    nextChild = () => {
      const cli = fakeCli(
        'console.log("ready in 300ms"); setTimeout(()=>{}, 60000);',
      );
      // The engine stamps after allocating the real port; requested 8080 was
      // taken, so it bound 8081. Written mid-tick, as it would be live.
      setTimeout(() => {
        writeModernContract(project, "chrome", {
          command: "dev",
          port: 8081,
          pid: process.pid,
          runtime: "attached",
          executorAttachedAt: new Date().toISOString(),
        });
      }, 1000);
      return cli;
    };

    const result = JSON.parse(
      await dev.handler({ projectPath: project, port: 8080 }),
    );

    expect(result.ok).toBe(true);
    expect(result.port).toBe(8081);
    expect(result.requestedPort).toBe(8080);
    expect(result.portNote).toContain("8081");

    // The never-disagree guarantee: wait reads the same contract.
    const waited = JSON.parse(
      await wait.handler({ projectPath: project, browser: "chrome" }),
    );
    expect(waited.port).toBe(result.port);
  }, 20_000);

  it("labels the requested port honestly when the contract has not landed", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli('console.log("ready in 300ms"); setTimeout(()=>{}, 60000);');

    const result = JSON.parse(
      await dev.handler({ projectPath: project, port: 8080 }),
    );

    expect(result.ok).toBe(true);
    // No `port` claim for a port that was never confirmed bound.
    expect(result.port).toBeUndefined();
    expect(result.requestedPort).toBe(8080);
    expect(result.portNote).toContain("extension_wait");
  }, 15_000);
});

describe("extension_dev build-only sessions", () => {
  it("points noBrowser sessions at an immediate wait, not a browser attach", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli('console.log("ready in 300ms"); setTimeout(()=>{}, 60000);');

    const result = JSON.parse(
      await dev.handler({ projectPath: project, noBrowser: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.hint).toContain("Build-only");
    expect(result.hint).toContain("browserAttached: false");
    expect(result.hint).not.toContain("fully loaded");

    // The registered session carries noBrowser, so extension_wait on the same
    // project returns at compile time instead of stalling on an attach that
    // cannot happen.
    writeModernContract(project, "chrome", { command: "dev", pid: process.pid });
    const before = Date.now();
    const waited = JSON.parse(
      await wait.handler({ projectPath: project, browser: "chrome" }),
    );
    expect(waited.status).toBe("ready");
    expect(waited.buildOnly).toBe(true);
    expect(waited.compiled).toBe(true);
    expect(waited.browserAttached).toBe(false);
    expect(waited.message).toContain("no browser");
    expect(Date.now() - before).toBeLessThan(10_000);
  }, 25_000);
});

describe("extension_dev earlyOutput denoise", () => {
  it("drops V8 asm.js warning lines but keeps real output", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli(
        'console.log("(node:66923) V8: file:///x/node_modules/es-module-lexer/dist/lexer.asm.js:2 Invalid asm.js: Invalid return type");' +
          'console.log("(Use `node --trace-warnings ...` to show where the warning was created)");' +
          'console.log("Invalid asm.js: Unexpected token");' +
          'console.log("Linking failure in asm.js: Unexpected stdlib member");' +
          'console.log("ready in 300ms");' +
          "setTimeout(()=>{}, 60000);",
      );

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(true);
    expect(result.earlyOutput).not.toContain("asm.js");
    expect(result.earlyOutput).not.toContain("trace-warnings");
    expect(result.earlyOutput).toContain("ready in 300ms");
  }, 15_000);
});
