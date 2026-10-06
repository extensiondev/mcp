import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runExtensionCli } from "../lib/exec";
import { handler as build } from "../tools/build";
import { buildSummary, readyContract } from "./fixtures/engine-answers";

function fixtureProject(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mcp-${name}-`));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name,
      version: "1.0",
      background: { service_worker: "background.js" },
    }),
  );
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  fs.writeFileSync(path.join(dir, "background.js"), "console.log('ok')\n");
  return dir;
}

function missingKeys(fixture: Record<string, unknown>, real: Record<string, unknown>): string[] {
  return Object.keys(fixture).filter((key) => !(key in real)).sort();
}

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

  /* @invariant The pinned engine itself answers this cell, through the tool,
     with --output json: the envelope must come from the summary the engine
     reported, and the shapes the fixtures hand every other cell must be
     shapes this engine writes. Before it, the only real-engine cell checked
     that dist/chrome existed. */
  it("reads the pinned engine's own build answer and matches the fixtures to it", async () => {
    const dir = fixtureProject("cli-smoke-json");
    try {
      const result = JSON.parse(await build({ projectPath: dir, browser: "chrome" } as never));
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      expect(result.status).toBe("built");
      expect(result.value.engineBuildStatus).toBe("built");
      expect(result.value.totalBytes).toBeGreaterThan(0);
      expect(result.value.totalAssets).toBeGreaterThan(0);
      expect((result.warnings ?? []).join(" ")).not.toContain("older than the one this server expects");
      expect((result.warnings ?? []).join(" ")).not.toContain("no summary from this run");

      const stateDir = path.join(dir, "dist", "extension-js", "chrome");
      const summary = JSON.parse(fs.readFileSync(path.join(stateDir, "build-summary.json"), "utf8"));
      expect(summary.browser).toBe("chrome");
      expect(missingKeys(buildSummary("chrome"), summary)).toEqual([]);

      const contract = JSON.parse(fs.readFileSync(path.join(stateDir, "ready.json"), "utf8"));
      expect(contract.command).toBe("build");
      expect(contract.schema).toBe(1);
      expect(contract.status).toBe("ready");
      expect(missingKeys(readyContract("build", "chrome"), contract)).toEqual([]);

      const events = fs
        .readFileSync(path.join(stateDir, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string });
      expect(events.map((e) => e.type)).toContain("compile_success");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 320_000);
});
