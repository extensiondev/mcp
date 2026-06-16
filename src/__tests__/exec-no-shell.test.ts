import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import spawn from "cross-spawn";

// SECURITY regression guard for src/lib/exec.ts.
//
// exec.ts spawns `npx extension <...args>` where some args are untrusted tool
// inputs (e.g. the extension_eval expression). It must NEVER use `{ shell: true }`
// -- that would run the argv through a shell and let metacharacters in those
// inputs execute arbitrary commands. These tests fail if the shell is reintroduced.

const execSource = fs.readFileSync(
  new URL("../lib/exec.ts", import.meta.url),
  "utf8",
);

// Strip comments so the guard checks actual code, not the explanatory note that
// mentions the old `shell: true` it replaced.
const execCode = execSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

describe("exec.ts spawns without a shell", () => {
  it("does not pass shell:true to spawn", () => {
    expect(/shell\s*:\s*true/.test(execCode)).toBe(false);
  });

  it("uses cross-spawn (safe .cmd resolution without a shell)", () => {
    expect(execCode).toMatch(/from\s+["']cross-spawn["']/);
  });

  it("cross-spawn does not interpret shell metacharacters in argv", async () => {
    const marker = path.join(
      os.tmpdir(),
      `mcp-no-shell-${process.pid}-${Date.now()}`,
    );
    // If argv were routed through a shell, `; touch <marker>` would create the
    // file. Without a shell it is just an inert argument to `node`.
    await new Promise<void>((resolve) => {
      const child = spawn(
        "node",
        ["-e", "process.exit(0)", `; touch ${marker}`],
        { stdio: "ignore" },
      );
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    const created = fs.existsSync(marker);
    if (created) fs.rmSync(marker, { force: true });
    expect(created).toBe(false);
  });
});
