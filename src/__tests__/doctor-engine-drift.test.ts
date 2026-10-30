import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import { handler } from "../tools/doctor";
import { pinnedCliVersion } from "../lib/exec";

const previousEnvPin = process.env.EXTENSION_MCP_CLI_VERSION;

const tmpDirs: string[] = [];

function fakeProject(engineVersion: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-doctor-drift-"));
  tmpDirs.push(dir);
  const binDir = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "extension");
  fs.writeFileSync(bin, "#!/bin/sh\necho '[]'\n");
  fs.chmodSync(bin, 0o755);
  const pkgDir = path.join(dir, "node_modules", "extension");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "extension", version: engineVersion }),
  );

  return dir;
}

afterEach(() => {
  if (previousEnvPin === undefined) {
    delete process.env.EXTENSION_MCP_CLI_VERSION;
  } else {
    process.env.EXTENSION_MCP_CLI_VERSION = previousEnvPin;
  }

  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const posixOnly = process.platform === "win32" ? it.skip : it;

function engineCheck(result: {
  value: { checks: Array<{ check: string; status: string; detail: string; remediation?: string }> };
}) {
  return result.value.checks.find((c) => c.check === "project-engine");
}

describe("extension_doctor engine drift", () => {
  posixOnly(
    "warns about a drifted project engine even without EXTENSION_MCP_CLI_VERSION",
    async () => {
      delete process.env.EXTENSION_MCP_CLI_VERSION;
      const project = fakeProject("3.9.9");

      const result = JSON.parse(
        await handler({ projectPath: project, browser: "chrome" }),
      );

      const check = engineCheck(result);
      expect(check).toBeDefined();
      expect(check!.status).toBe("warn");
      expect(check!.detail).toContain("3.9.9");
      expect(check!.detail).toContain(pinnedCliVersion());
    },
    20_000,
  );

  posixOnly(
    "compares versions as semver, so pin 4.0.17 does not swallow engine 4.0.1",
    async () => {
      process.env.EXTENSION_MCP_CLI_VERSION = "4.0.17";
      const project = fakeProject("4.0.1");

      const result = JSON.parse(
        await handler({ projectPath: project, browser: "chrome" }),
      );

      const check = engineCheck(result)!;
      expect(check.status).toBe("warn");
      expect(check.remediation).toContain("npm i -D extension@4.0.17");
    },
    20_000,
  );

  posixOnly(
    "keeps a project engine newer than the pin: pass, says so, and never asks for a downgrade",
    async () => {
      process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";
      const project = fakeProject("4.1.37-canary.1793360022.4f7af0f6");

      const result = JSON.parse(
        await handler({ projectPath: project, browser: "chrome" }),
      );

      const check = engineCheck(result)!;
      expect(check.status).toBe("pass");
      expect(check.detail).toContain("4.1.37-canary.1793360022.4f7af0f6");
      expect(check.detail).toContain("newer than the extension@4.1.36");
      expect(check.detail).toContain("project bin");
      expect(check.remediation).toBeUndefined();
    },
    20_000,
  );

  posixOnly(
    "reads a canary of the pinned base as newer, and a release above the pin as newer",
    async () => {
      process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";

      for (const engine of ["4.1.36-canary.7.abc1234", "4.2.0", "5.0.0"]) {
        const result = JSON.parse(
          await handler({ projectPath: fakeProject(engine), browser: "chrome" }),
        );

        const check = engineCheck(result)!;
        expect(check.status, engine).toBe("pass");
        expect(check.remediation, engine).toBeUndefined();
      }
    },
    40_000,
  );

  posixOnly(
    "keeps the upgrade remediation for an older project engine",
    async () => {
      process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";
      const project = fakeProject("4.1.35");

      const result = JSON.parse(
        await handler({ projectPath: project, browser: "chrome" }),
      );

      const check = engineCheck(result)!;
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("but the MCP pins extension@4.1.36");
      expect(check.remediation).toContain("npm i -D extension@4.1.36");
    },
    20_000,
  );

  posixOnly(
    "passes when the project engine matches the pin exactly",
    async () => {
      delete process.env.EXTENSION_MCP_CLI_VERSION;
      const project = fakeProject(pinnedCliVersion());

      const result = JSON.parse(
        await handler({ projectPath: project, browser: "chrome" }),
      );

      expect(engineCheck(result)!.status).toBe("pass");
    },
    20_000,
  );
});
