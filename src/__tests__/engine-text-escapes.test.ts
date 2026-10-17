import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, it, expect, vi, afterEach } from "vitest";

import { doctorFrame, errorContract } from "./fixtures/engine-answers";

import type { ChildProcess } from "node:child_process";
import type * as ExecModule from "../lib/exec";
import type { SpawnedCli } from "../lib/exec";

const MISSING_WASM = "/nonexistent/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm";
const ENGINE_LINE = `Error: ENOENT: no such file or directory, open '${MISSING_WASM}'`;
const COLORED_FRAME =
  "\u001b[31m×\u001b[0m caused by plugins in Compilation.hooks.processAssets\n" +
  `\u001b[2m  ╰─▶ \u001b[0m ${ENGINE_LINE}`;

const spawned: ChildProcess[] = [];
const tmpDirs: string[] = [];
let doctorLegs: Parameters<typeof doctorFrame>[0] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-engine-escapes-"));
  tmpDirs.push(dir);

  return dir;
}

function writeFailedContract(projectPath: string): void {
  const file = path.join(projectPath, "dist", "extension-js", "chrome", "ready.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      errorContract("chrome", "compile_failed", {
        message: COLORED_FRAME,
        distPath: path.join(projectPath, "dist", "chrome"),
      }),
    ),
  );
}

let project = "";

function coloredCli(): SpawnedCli {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-escapes-cli-"));
  tmpDirs.push(logDir);
  const logPath = path.join(logDir, "session.log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(
    process.execPath,
    ["-e", `process.stderr.write(${JSON.stringify(`${COLORED_FRAME}\n`)}); setTimeout(()=>{}, 60000);`],
    { stdio: ["ignore", fd, fd] },
  );
  fs.closeSync(fd);
  spawned.push(child);
  setTimeout(() => writeFailedContract(project), 300);

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
    spawnExtensionCli: () => coloredCli(),
    runExtensionCli: async () => ({
      code: 1,
      stdout: JSON.stringify(doctorFrame(doctorLegs)),
      stderr: "",
    }),
  };
});

const dev = await import("../tools/dev");
const wait = await import("../tools/wait");
const doctor = await import("../tools/doctor");
const { removeSession } = await import("../lib/process-manager");

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  for (const dir of tmpDirs.splice(0)) {
    try {
      removeSession(dir, "chrome");
    } catch {
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("engine text reaches the agent without terminal escapes", () => {
  it("extension_dev relays a colored first-compile failure as plain text", async () => {
    project = tmpProject();

    const text = await dev.handler({ projectPath: project, browser: "chrome", wait: false });
    const answer = JSON.parse(text);

    expect(answer.status).toBe("boot-failed");
    expect(text).not.toContain("\\u001b");
    expect(answer.error.message).toContain(ENGINE_LINE);
    expect(answer.value.output).toContain(ENGINE_LINE);
  }, 20_000);

  it("extension_wait lists the compile error it reports, as plain text", async () => {
    project = tmpProject();
    writeFailedContract(project);

    const text = await wait.handler({ projectPath: project, browser: "chrome", timeoutMs: 1000 });
    const answer = JSON.parse(text);

    expect(answer.status).toBe("contract-error");
    expect(text).not.toContain("\\u001b");
    expect(answer.error.message).toContain(ENGINE_LINE);
    expect(answer.value.errors).toHaveLength(1);
    expect(answer.value.errors[0]).toContain(ENGINE_LINE);
  });

  it("extension_doctor details carry the engine line without escapes", async () => {
    project = tmpProject();
    writeFailedContract(project);
    doctorLegs = [
      { check: "ready-contract", status: "fail", detail: `status: error (compile_failed): ${COLORED_FRAME}` },
    ];

    const text = await doctor.handler({ projectPath: project, browser: "chrome" });
    const answer = JSON.parse(text);
    const runtime = answer.value.checks.find((leg: { check: string }) => leg.check === "runtime-errors");

    expect(text).not.toContain("\\u001b");
    expect(runtime.detail).toContain(ENGINE_LINE);
    expect(answer.value.checks[0].detail).toContain(ENGINE_LINE);
  });
});
