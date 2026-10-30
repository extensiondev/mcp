import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import { handler } from "../tools/doctor";
import { declaredMatch } from "../lib/engine-declared";
import { pinnedCliVersion } from "../lib/exec";
import { projectEngineCheck } from "../lib/project-engine-check";

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

function declare(project: string, spec: string | null, lockfile?: string): void {
  const deps = spec === null ? {} : { devDependencies: { extension: spec } };
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "fake", ...deps }));
  if (lockfile) fs.writeFileSync(path.join(project, lockfile), "");
}

const DRIFT_SENTENCE =
  "package.json pins extension@4.1.37-canary.1793360022.4f7af0f6, node_modules has extension@4.1.36; the project's own build and tests run on the installed copy; run npm install (or pnpm install) to match";

describe("extension_doctor project-engine against the package.json pin (ledger 279)", () => {
  posixOnly(
    "warns when node_modules holds a version other than the exact one package.json pins, and answers engineDeclared",
    async () => {
      process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";
      const project = fakeProject("4.1.36");
      declare(project, "4.1.37-canary.1793360022.4f7af0f6");

      const result = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));
      const check = engineCheck(result)!;

      expect(check.status).toBe("warn");
      expect(check.detail).toContain("project-local extension@4.1.36");
      expect(check.detail).toContain(DRIFT_SENTENCE);
      expect(check.remediation).toBe(
        `Run \`(cd ${project} && npm install)\` so node_modules/extension matches the package.json pin extension@4.1.37-canary.1793360022.4f7af0f6.`,
      );

      expect(result.value.engineVersion).toBe("4.1.36");
      expect(result.value.engineDeclared).toBe("4.1.37-canary.1793360022.4f7af0f6");
    },
    20_000,
  );

  it("names the install command of the lockfile and keeps the pin remediation after it", () => {
    process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";
    const project = fakeProject("4.1.35");
    declare(project, "4.1.36", "pnpm-lock.yaml");

    const check = projectEngineCheck(project)!;

    expect(check.status).toBe("warn");
    expect(check.detail).toContain("package.json pins extension@4.1.36, node_modules has extension@4.1.35");
    expect(check.remediation).toContain(`(cd ${project} && pnpm install)`);
    expect(check.remediation).toContain("npm i -D extension@4.1.36");
  });

  it("passes a satisfied caret or tilde range without a drift sentence", () => {
    process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";

    for (const spec of ["^4.1.0", "~4.1.2", "4.1.36", "=4.1.36", "v4.1.36"]) {
      const project = fakeProject("4.1.36");
      declare(project, spec);

      const check = projectEngineCheck(project)!;
      expect(check.status, spec).toBe("pass");
      expect(check.detail, spec).not.toContain("package.json");
      expect(check.remediation, spec).toBeUndefined();
    }
  });

  it("warns on a range the installed version falls outside of", () => {
    process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";

    for (const spec of ["~4.0.0", "^3.9.0", "^5.0.0"]) {
      const project = fakeProject("4.1.36");
      declare(project, spec);

      const check = projectEngineCheck(project)!;
      expect(check.status, spec).toBe("warn");
      expect(check.detail, spec).toContain(`package.json pins extension@${spec}, node_modules has extension@4.1.36`);
    }
  });

  it("reports a workspace, file, link, latest or git spec as declared without a comparison", () => {
    process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";

    for (const spec of ["workspace:*", "file:../extension", "link:../extension", "latest", "github:extension-js/extension.js", "git+https://github.com/extension-js/extension.js.git"]) {
      const project = fakeProject("4.1.36");
      declare(project, spec);

      const check = projectEngineCheck(project)!;
      expect(check.status, spec).toBe("pass");
      expect(check.detail, spec).toContain(`package.json declares extension as ${spec}`);
      expect(check.remediation, spec).toBeUndefined();
    }
  });

  it("says a range it cannot parse could not be compared and does not warn", () => {
    process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";
    const project = fakeProject("4.1.36");
    declare(project, ">=4.0.0 <5");

    const check = projectEngineCheck(project)!;

    expect(check.status).toBe("pass");
    expect(check.detail).toContain("package.json declares extension@>=4.0.0 <5, which could not be compared with the installed extension@4.1.36");
    expect(check.remediation).toBeUndefined();
  });

  posixOnly(
    "says when package.json declares no extension dependency and answers engineDeclared null",
    async () => {
      process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";
      const project = fakeProject("4.1.36");
      declare(project, null);

      const result = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));
      const check = engineCheck(result)!;

      expect(check.status).toBe("pass");
      expect(check.detail).toContain("package.json declares no extension dependency");
      expect(result.value.engineVersion).toBe("4.1.36");
      expect(result.value.engineDeclared).toBeNull();
    },
    20_000,
  );

  it("compares an exact pin, a caret and a tilde the way npm does, prereleases included", () => {
    expect(declaredMatch("4.1.37-canary.1793360022.4f7af0f6", "4.1.36")).toBe("drift");
    expect(declaredMatch("4.1.37-canary.1793360022.4f7af0f6", "4.1.37-canary.1793360022.4f7af0f6")).toBe("match");
    expect(declaredMatch("^4.1.0", "4.1.37-canary.1")).toBe("drift");
    expect(declaredMatch("^4.1.37-canary.1", "4.1.37-canary.2")).toBe("match");
    expect(declaredMatch("^0.3.1", "0.3.9")).toBe("match");
    expect(declaredMatch("^0.3.1", "0.4.0")).toBe("drift");
    expect(declaredMatch("^0.0.3", "0.0.4")).toBe("drift");
    expect(declaredMatch("~4.1.2", "4.2.0")).toBe("drift");
    expect(declaredMatch("*", "4.1.36")).toBe("unparsed");
    expect(declaredMatch("4.x", "4.1.36")).toBe("unparsed");
    expect(declaredMatch("npm:extension@4.1.36", "4.1.36")).toBe("spec");
  });
});
