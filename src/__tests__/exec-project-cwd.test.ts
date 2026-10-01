import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeExtensionInvocation,
  spawnExtensionCli,
  type SpawnedCli,
} from "../lib/exec";

const cleanups: Array<() => void> = [];
let live: SpawnedCli | undefined;

function fakeProject(binScript: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-exec-cwd-"));
  const binDir = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "extension");
  fs.writeFileSync(bin, `#!/bin/sh\n${binScript}\n`);
  fs.chmodSync(bin, 0o755);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

afterEach(() => {
  if (live?.child.pid) {
    try {
      process.kill(-live.child.pid, "SIGKILL");
    } catch {
      try {
        live.child.kill("SIGKILL");
      } catch {
      }
    }
  }
  live = undefined;
  for (const fn of cleanups.splice(0)) fn();
});

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("the engine runs in the project, not where the MCP client started the server", () => {
  posixOnly("spawns the dev CLI with the project as its working directory", async () => {
    const project = fakeProject('pwd; sleep 30');
    live = spawnExtensionCli(["dev", project], { projectDir: project });
    await new Promise((r) => setTimeout(r, 400));

    const printed = live.readOutput().trim().split("\n")[0];

    expect(fs.realpathSync(printed)).toBe(fs.realpathSync(project));
    expect(printed).not.toBe(process.cwd());
  });

  it("names the project's own engine when the project has one", () => {
    const project = fakeProject("exit 0");

    expect(describeExtensionInvocation(project)).toContain("the project's own Extension.js");
    expect(describeExtensionInvocation(project)).toContain(path.join("node_modules", ".bin", "extension"));
  });

  it("names the pinned engine when the project has none", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-exec-cwd-bare-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const described = describeExtensionInvocation(dir);

    expect(described).toContain("npx extension@");
    expect(described).toContain("pinned engine");
  });
});
