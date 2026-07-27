import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

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
const {
  writeModernContract,
  writeMachineContractError,
  writeStampedContractError,
} = await import("./fixtures/ready-contract");

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

    expect(result.schema).toBe(1);
    expect(result.command).toBe("extension_dev");
    expect(result.ok).toBe(false);
    expect(result.status).toBe("exited");
    expect(result.error.code).toBe("E_SESSION_EXITED");
    expect(result.value.exitCode).toBe(1);
    expect(result.error.message).toContain("exited during startup");
    expect(result.value.output).toContain("EADDRINUSE");
  }, 15_000);

  it("surfaces a signalled death", async () => {
    const project = tmpProject();
    nextChild = () => fakeCli("process.kill(process.pid, 'SIGKILL')");

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("exited");
    expect(result.value.signal).toBe("SIGKILL");
  }, 15_000);

  it("applies to extension_start too", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli('console.error("build failed: missing dependency"); process.exit(1);');

    const result = JSON.parse(await start.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.command).toBe("extension_start");
    expect(result.status).toBe("exited");
    expect(result.value.output).toContain("build failed");
  }, 20_000);

  it("reads a failed first compile off the machine contract, not the output", async () => {
    const project = tmpProject();
    nextChild = () => {
      const cli = fakeCli('console.log("building"); setTimeout(()=>{}, 60000);');
      setTimeout(() => {
        writeMachineContractError(project, "chrome", {
          code: "first_compile",
          message: "Compile failed",
          errors: ["Module not found: ./src/panel.js"],
        });
      }, 300);
      return cli;
    };

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("compile-failed");
    expect(result.error.code).toBe("E_FIRST_COMPILE");
    expect(result.value.compileErrors[0]).toContain("./src/panel.js");
    // The contract answered, so nothing read the dev server's prose.
    expect(result.warnings).toEqual([]);
    expect(result.hint).toContain("extension_wait");
  }, 20_000);

  it("trusts the profile-lock stamp even from a CLI that declares no schema", async () => {
    const project = tmpProject();
    nextChild = () => {
      const cli = fakeCli('console.log("building"); setTimeout(()=>{}, 60000);');
      setTimeout(() => {
        // What the shipped engine writes today: schemaVersion 2, no `schema: 1`.
        // The stamp is still authoritative, so the verdict must not wait for the
        // capability probe to pass.
        writeStampedContractError(project, "chrome", {
          code: "profile_locked",
          message: "Chromium profile is already in use by process 77 on host h.",
          profileLockOwner: { host: "h", pid: 77 },
        });
      }, 300);
      return cli;
    };

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.status).toBe("profile-locked");
    expect(result.error.code).toBe("E_PROFILE_LOCKED");
    expect(result.value.owner).toEqual({ host: "h", pid: 77 });
    expect(result.warnings).toEqual([]);
  }, 20_000);

  it("falls back to the output scrape when the CLI stamps no contract", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli(
        'console.log("\\u2716\\u2716\\u2716 Probe compiled with errors in 180 ms. ERROR in ./src/panel.js NOT FOUND"); setTimeout(()=>{}, 60000);',
      );

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("compile-failed");
    expect(result.error.code).toBe("E_FIRST_COMPILE");
    expect(result.value.compileErrors).toEqual([]);
    expect(result.value.output).toContain("compiled with errors");
    // Degraded fidelity is disclosed rather than silently accepted.
    expect(result.warnings.join(" ")).toContain("machine contract");
  }, 20_000);

  it("splits a locked profile out of browser-exited when the contract says so", async () => {
    const project = tmpProject();
    nextChild = () => {
      const cli = fakeCli('console.log("building"); setTimeout(()=>{}, 60000);');
      setTimeout(() => {
        // The exact stamp browsers-lib/ready-stamp.ts writes.
        writeMachineContractError(project, "chrome", {
          code: "profile_locked",
          message:
            'Chromium profile "/tmp/p/dist/extension-profile-chrome" is already in use by process 4242 on host somehost. Close that browser session or use a different profile before starting Extension.js.',
          profileLockedAt: "2026-07-27T09:00:00.000Z",
          profileLockOwner: { host: "somehost", pid: 4242 },
        });
      }, 300);
      return cli;
    };

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("profile-locked");
    expect(result.error.code).toBe("E_PROFILE_LOCKED");
    // The engine's own sentence survives; it names the profile path, which
    // this side cannot reconstruct.
    expect(result.error.message).toContain("already in use by process 4242");
    expect(result.error.message).toContain("extension-profile-chrome");
    expect(result.value.owner).toEqual({ host: "somehost", pid: 4242 });
    expect(result.value.lockedAt).toBe("2026-07-27T09:00:00.000Z");
    // Nothing was scraped, so no fidelity warning.
    expect(result.warnings).toEqual([]);
  }, 20_000);

  it("still reports started for a server that survives the tick", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli('console.log("ready in 300ms"); setTimeout(()=>{}, 60000);');

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.schema).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("started");
    expect(result.value.browser).toBe("chrome");
    // The success frame points at the log instead of echoing a prose tail.
    expect(result.value.logPath).toBeTruthy();
    expect(result.earlyOutput).toBeUndefined();
  }, 15_000);
});

describe("extension_dev port truth", () => {
  it("reports the bound port from ready.json and never disagrees with wait", async () => {
    const project = tmpProject();
    nextChild = () => {
      const cli = fakeCli(
        'console.log("ready in 300ms"); setTimeout(()=>{}, 60000);',
      );
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
    expect(result.value.port).toBe(8081);
    expect(result.value.requestedPort).toBe(8080);
    expect(result.warnings.join(" ")).toContain("8081");

    const waited = JSON.parse(
      await wait.handler({ projectPath: project, browser: "chrome" }),
    );
    expect(waited.value.port).toBe(result.value.port);
  }, 20_000);

  it("labels the requested port honestly when the contract has not landed", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli('console.log("ready in 300ms"); setTimeout(()=>{}, 60000);');

    const result = JSON.parse(
      await dev.handler({ projectPath: project, port: 8080 }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.port).toBeUndefined();
    expect(result.value.requestedPort).toBe(8080);
    expect(result.warnings.join(" ")).toContain("extension_wait");
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

    writeModernContract(project, "chrome", { command: "dev", pid: process.pid });
    const before = Date.now();
    const waited = JSON.parse(
      await wait.handler({ projectPath: project, browser: "chrome" }),
    );
    expect(waited.status).toBe("ready");
    expect(waited.value.buildOnly).toBe(true);
    expect(waited.value.compiled).toBe(true);
    expect(waited.value.browserAttached).toBe(false);
    expect(waited.hint).toContain("no browser");
    expect(Date.now() - before).toBeLessThan(10_000);
  }, 25_000);
});

describe("extension_dev boot noise", () => {
  it("does not read npm's cold-install notice as a compile failure", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli(
        'console.log("npm warn exec The following package was not found and will be installed: extension@4.0.16-canary.1.abc");' +
          'console.log("ready in 300ms");' +
          "setTimeout(()=>{}, 60000);",
      );

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("started");
    expect(result.error).toBeNull();
  }, 15_000);

  it("keeps V8 asm.js chatter out of the failure evidence", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli(
        'console.log("(node:66923) V8: file:///x/node_modules/es-module-lexer/dist/lexer.asm.js:2 Invalid asm.js: Invalid return type");' +
          'console.log("(Use `node --trace-warnings ...` to show where the warning was created)");' +
          'console.log("Invalid asm.js: Unexpected token");' +
          'console.log("Linking failure in asm.js: Unexpected stdlib member");' +
          'console.error("Error: listen EADDRINUSE: address already in use :::8080");' +
          "process.exit(1);",
      );

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.value.output).not.toContain("asm.js");
    expect(result.value.output).not.toContain("trace-warnings");
    expect(result.value.output).toContain("EADDRINUSE");
  }, 15_000);
});
