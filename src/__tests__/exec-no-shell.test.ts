import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import spawn from "cross-spawn";

const execSource = fs.readFileSync(
  new URL("../lib/exec.ts", import.meta.url),
  "utf8",
);

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
