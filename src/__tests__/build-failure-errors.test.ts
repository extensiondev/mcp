import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import { envelope } from "../lib/envelope";
import { browserFromCliArgs, writeEngineDist } from "./fixtures/engine-answers";

import type * as ExecModule from "../lib/exec";
import type * as EngineVersionModule from "../lib/engine-version";

let onBuild: () => { code: number; stdout: string; stderr: string } = () => ({
  code: 0,
  stdout: "",
  stderr: "",
});
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      const answer = onBuild();

      if (args[0] === "build" && answer.code === 0) {
        writeEngineDist(args[1]!, browserFromCliArgs(args));
      }

      return answer;
    },
    pinnedCliVersion: () => "4.1.30",
  };
});

vi.mock("../lib/engine-version", async (importOriginal) => {
  const actual = await importOriginal<typeof EngineVersionModule>();

  return {
    ...actual,
    refusedTheOutputFlag: () => false,
    buildOutputVerdict: async () => ({ kind: "supported" }),
  };
});

const build = await import("../tools/build");

const dirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-errors-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "F", version: "1.0.0" }),
  );

  return dir;
}

function failedFrame(): string {
  return envelope({
    ok: false,
    command: "build",
    status: "build-failed",
    error: { code: "E_BUILD_FAILED", message: "Build failed with errors" },
  });
}

function stampContract(dir: string, errors: string[]): void {
  const readyDir = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(
    path.join(readyDir, "ready.json"),
    JSON.stringify({ schema: 1, status: "error", command: "build", browser: "chrome", errors }),
  );
}

afterEach(() => {
  onBuild = () => ({ code: 0, stdout: "", stderr: "" });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_build on a failed build carries the compiler errors", () => {
  it("reads the errors the engine stamped on the contract and points at them", async () => {
    const dir = project();

    onBuild = () => {
      stampContract(dir, [
        "\u001b[31mERROR\u001b[0m in ./src/App.vue: Module not found: Can't resolve '../shared/x'",
        "./src/main.ts(3,10): error TS2307: Cannot find module 'vue'",
      ]);

      return { code: 1, stdout: failedFrame(), stderr: "" };
    };

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "chrome" }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_BUILD_FAILED");
    expect(result.value.errors).toHaveLength(2);
    expect(result.value.errors[0]).toContain("Can't resolve '../shared/x'");
    expect(result.value.errors[0]).not.toContain("\u001b");
    expect(result.hint).toContain("value.errors");
    expect(result.hint).not.toContain("src/manifest.json");
  });

  it("carries the bundler's own output when the contract holds no errors", async () => {
    const dir = project();
    onBuild = () => ({
      code: 1,
      stdout: failedFrame(),
      stderr: "rspack: 3 errors in 12 modules\n  App.vue:1:1 unexpected token",
    });

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "chrome" }));

    expect(result.ok).toBe(false);
    expect(result.value.errors).toBeUndefined();
    expect(result.value.output).toContain("unexpected token");
    expect(result.hint).toContain("value.output");
    expect(result.hint).not.toContain("valid src/manifest.json");
  });

  it("ignores a contract left by an earlier build", async () => {
    const dir = project();
    stampContract(dir, ["stale error from last week"]);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, "dist", "extension-js", "chrome", "ready.json"), past, past);
    onBuild = () => ({ code: 1, stdout: failedFrame(), stderr: "fresh failure" });

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "chrome" }));

    expect(result.value.errors).toBeUndefined();
    expect(result.value.output).toContain("fresh failure");
  });
});
