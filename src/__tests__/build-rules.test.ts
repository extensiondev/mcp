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
let devSessionOwnsTheDist = false;
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      const browser = browserFromCliArgs(args);

      if (failTheBuild) return { code: 1, stdout: "", stderr: "compile failed" };

      if (devSessionOwnsTheDist) {
        return {
          code: 1,
          stdout: `${JSON.stringify(cliRefusal("build", "E_DEV_SESSION_DIST_SHARED", `A dev session (PID ${process.pid}) owns dist/${browser}, so this build was not written.`))}\n`,
          stderr: "",
        };
      }

      writeEngineDist(args[1]!, browser);

      return buildCliAnswer(args[1]!, browser);
    },
  };
});

const build = await import("../tools/build");
const { registerSession, removeSession } = await import("../lib/process-manager");
const { buildCliAnswer, browserFromCliArgs, cliRefusal, writeEngineDist } = await import("./fixtures/engine-answers");

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
  devSessionOwnsTheDist = false;

  for (const dir of tmpDirs.splice(0)) {
    removeSession(dir, "chrome", process.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("402: a build over a registered dev session's dist is refused before the engine runs, never written and warned about after", () => {
  it("refuses with the session's pid and names outDir and extension_stop", async () => {
    const dir = project();
    registerSession({ projectPath: dir, browser: "chrome", pid: process.pid, command: "dev" });

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "chrome" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("build-refused");
    expect(result.error.code).toBe("E_DEV_SESSION_DIST_SHARED");
    expect(result.value.livePids).toEqual([process.pid]);
    expect(result.hint).toContain("outDir");
    expect(result.hint).toContain("extension_stop");
    expect(JSON.stringify(result)).not.toContain("wrote over");
    expect(fs.existsSync(path.join(dir, "dist", "chrome", "manifest.json"))).toBe(false);
  });

  it("says nothing about clobbering when the build failed for another reason", async () => {
    const dir = project();
    failTheBuild = true;

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "chrome" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("build-failed");
    expect(JSON.stringify(result)).not.toContain("wrote over");
  });
});

describe("a build the engine refuses because a live dev session serves the dist answers that refusal, not a compile failure", () => {
  it("passes the engine's code through and points at outDir and extension_stop", async () => {
    const dir = project();
    devSessionOwnsTheDist = true;

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "chrome" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("build-refused");
    expect(result.error.code).toBe("E_DEV_SESSION_DIST_SHARED");
    expect(result.value.livePids).toEqual([]);
    expect(result.hint).toContain("outDir");
    expect(result.hint).toContain("extension_stop");
    expect(JSON.stringify(result)).not.toContain("wrote over");
  });
});
