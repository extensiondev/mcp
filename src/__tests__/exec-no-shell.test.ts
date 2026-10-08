import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { runExtensionCli } from "../lib/exec";

const posixOnly = process.platform === "win32" ? it.skip : it;

const execSource = fs.readFileSync(
  new URL("../lib/exec.ts", import.meta.url),
  "utf8",
);

function projectWithRecordingEngine(): { project: string; argvFile: string } {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-no-shell-"));
  const bin = path.join(project, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  const argvFile = path.join(project, "argv.json");
  fs.writeFileSync(
    path.join(bin, "extension"),
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o755 },
  );

  return { project, argvFile };
}

describe("exec.ts spawns the engine without a shell", () => {
  it("does not pass shell:true to spawn", () => {
    expect(/shell\s*:\s*true/.test(execSource)).toBe(false);
  });

  posixOnly("hands shell metacharacters to the engine as one argument instead of interpreting them (Windows runs the .cmd shim through cmd.exe by design)", async () => {
    const { project, argvFile } = projectWithRecordingEngine();
    const marker = path.join(project, "touched-by-a-shell");

    try {
      const result = await runExtensionCli(
        ["build", `; touch ${marker}`, "&&", "echo", "$HOME"],
        { cwd: project, timeoutMs: 10_000 },
      );

      expect(result.code).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
      expect(JSON.parse(fs.readFileSync(argvFile, "utf8"))).toEqual([
        "build",
        `; touch ${marker}`,
        "&&",
        "echo",
        "$HOME",
      ]);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
