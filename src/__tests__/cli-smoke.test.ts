import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runExtensionCli } from "../lib/exec";

describe.skipIf(!process.env.RUN_CLI_SMOKE)("real-CLI smoke (npx pin)", () => {
  it("builds a fixture project through the pinned extension CLI", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cli-smoke-"));
    try {
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "cli-smoke",
          version: "1.0",
          background: { service_worker: "background.js" },
        }),
      );
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "cli-smoke", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(dir, "background.js"), "console.log('ok')\n");

      const { code, stdout, stderr } = await runExtensionCli(
        ["build", dir, "--browser", "chrome"],
        { cwd: dir, timeoutMs: 300_000 },
      );
      expect(code, stderr || stdout).toBe(0);
      expect(fs.existsSync(path.join(dir, "dist", "chrome"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 320_000);
});
