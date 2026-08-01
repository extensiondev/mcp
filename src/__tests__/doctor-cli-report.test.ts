import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const cli = vi.hoisted(() => ({
  response: { code: 1, stdout: "", stderr: "" },
}));

vi.mock("../lib/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/exec")>()),
  runExtensionCli: async () => cli.response,
  pinnedCliVersion: () => "",
}));

vi.mock("../lib/engine-version", () => ({
  refusedTheOutputFlag: () => false,
  outputFlagRefusalMessage: async () => "unused",
}));

import { handler } from "../tools/doctor";

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-doctor-report-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_doctor keeps the CLI's own report when its output is not JSON", () => {
  it("carries the unparsed check list instead of swallowing it", async () => {
    const report = [
      "doctor (chrome), 6/7 checks passed",
      "fail control-channel: no active control channel found",
      "  remediation: start the dev server with `extension dev` and retry",
    ].join("\n");
    cli.response = { code: 1, stdout: report, stderr: "" };

    const out = JSON.parse(await handler({ projectPath: tmpProject(), browser: "chrome" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("cli-failed");
    expect(out.error.code).toBe("E_CLI");
    expect(out.value.browser).toBe("chrome");
    expect(out.value.cliReport).toContain("6/7 checks passed");
    expect(out.value.cliReport).toContain("no active control channel found");
    expect(out.hint).toMatch(/cliReport/);
    expect(out.hint).not.toMatch(/predate/);
  });

  it("only guesses at a stale CLI when there is no output to show", async () => {
    cli.response = { code: 1, stdout: "", stderr: "" };

    const out = JSON.parse(await handler({ projectPath: tmpProject(), browser: "chrome" }));

    expect(out.ok).toBe(false);
    expect(out.error.message).toContain("exited with code 1");
    expect(out.value.cliReport).toBeUndefined();
    expect(out.hint).toMatch(/predate/);
  });
});
