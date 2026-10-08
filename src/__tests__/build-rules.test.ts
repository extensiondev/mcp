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

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as ExecModule from "../lib/exec";

let failTheBuild = false;
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      const browser = browserFromCliArgs(args);

      if (failTheBuild) return { code: 1, stdout: "", stderr: "compile failed" };

      writeEngineDist(args[1]!, browser);

      return buildCliAnswer(args[1]!, browser);
    },
  };
});

const build = await import("../tools/build");
const { registerSession, removeSession } = await import("../lib/process-manager");
const { buildCliAnswer, browserFromCliArgs, writeEngineDist } = await import("./fixtures/engine-answers");

const tmpDirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-rules-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "rules", version: "1.0.0" }),
  );

  return dir;
}

afterEach(() => {
  failTheBuild = false;

  for (const dir of tmpDirs.splice(0)) {
    removeSession(dir, "chrome", process.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("the clobber warning is said only on a build that wrote, because the engine never promotes its staging dir on a failed build", () => {
  it("warns that a live dev session's dist was written over when the build wrote", async () => {
    const dir = project();
    registerSession({ projectPath: dir, browser: "chrome", pid: process.pid, command: "dev" });

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "chrome" }));

    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("wrote over its dist/chrome output");
  });

  it("says nothing about clobbering when the build failed and wrote nothing", async () => {
    const dir = project();
    registerSession({ projectPath: dir, browser: "chrome", pid: process.pid, command: "dev" });
    failTheBuild = true;

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "chrome" }));

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("wrote over");
  });
});
