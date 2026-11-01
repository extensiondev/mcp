// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { driftRemediation } from "../lib/engine-declared";
import { projectEngineCheck } from "../lib/project-engine-check";
import { shellPath } from "../lib/publish-link";

let scaffoldTarget = "";

vi.mock("extension-create", () => ({
  extensionCreate: vi.fn(async (_input: string, opts: { template: string }) => {
    fs.mkdirSync(scaffoldTarget, { recursive: true });
    fs.writeFileSync(path.join(scaffoldTarget, "manifest.json"), "{}");
    fs.writeFileSync(
      path.join(scaffoldTarget, "package.json"),
      JSON.stringify({ name: "probe", devDependencies: { extension: "4.0.0" } }),
    );

    return {
      projectPath: scaffoldTarget,
      projectName: path.basename(scaffoldTarget),
      template: opts.template,
      depsInstalled: true,
      packageManager: "npm",
    };
  }),
}));

const create = await import("../tools/create");

const SHELLS = ["/bin/sh", "/bin/zsh", "/bin/bash"].filter((shell) => fs.existsSync(shell));
const AWKWARD = "My Ext $HOME it's";
const savedPin = process.env.EXTENSION_MCP_CLI_VERSION;
const tmpDirs: string[] = [];

function awkwardDir(): string {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-pathq-")));
  tmpDirs.push(parent);
  const dir = path.join(parent, AWKWARD);
  fs.mkdirSync(dir);

  return dir;
}

function cdWord(text: string): string {
  const word = /cd (.+?) && /.exec(text)?.[1];
  expect(word).toBeDefined();

  return word!;
}

function landsIn(shell: string, word: string): string {
  return execFileSync(shell, ["-c", `cd ${word} && pwd -P`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function printed(shell: string, word: string): string {
  return execFileSync(shell, ["-c", `printf '%s' ${word}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

afterEach(() => {
  if (savedPin === undefined) delete process.env.EXTENSION_MCP_CLI_VERSION;
  else process.env.EXTENSION_MCP_CLI_VERSION = savedPin;

  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("every filesystem path the MCP prints inside a shell command reaches the shell whole", () => {
  it("has sh and zsh to run the commands in", () => {
    expect(SHELLS).toContain("/bin/sh");
  });

  it("single-quotes a path with a space, a $ and a single quote, and leaves a plain path bare", () => {
    const awkward = `/tmp/${AWKWARD}`;

    expect(shellPath(awkward)).toBe(`'/tmp/My Ext $HOME it'\\''s'`);
    expect(shellPath("/Users/me/my-ext_1.0")).toBe("/Users/me/my-ext_1.0");
    for (const shell of SHELLS) expect(printed(shell, shellPath(awkward))).toBe(awkward);
  });

  it("prints the install remediation for a package.json drift with a cd that lands in the project", () => {
    const dir = awkwardDir();
    const line = driftRemediation(dir, "4.1.36");

    for (const shell of SHELLS) expect(landsIn(shell, cdWord(line))).toBe(dir);
  });

  it("prints the doctor's pinned engine remediation with a cd that lands in the project", () => {
    process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";
    const dir = awkwardDir();
    const engine = path.join(dir, "node_modules", "extension");
    fs.mkdirSync(engine, { recursive: true });
    fs.writeFileSync(path.join(engine, "package.json"), JSON.stringify({ name: "extension", version: "3.9.9" }));

    const check = projectEngineCheck(dir)!;

    expect(check.remediation).toContain("npm i -D extension@4.1.36");
    for (const shell of SHELLS) expect(landsIn(shell, cdWord(check.remediation!))).toBe(dir);
  });

  it("prints extension_create's manual alternative and engine warning with a cd that lands in the project", async () => {
    process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";
    const dir = awkwardDir();
    fs.rmdirSync(dir);
    scaffoldTarget = dir;

    const result = JSON.parse(
      await create.handler({ projectName: AWKWARD, parentDir: path.dirname(dir) }),
    );

    const warning = (result.warnings as unknown[]).find((row): row is string => typeof row === "string" && row.includes("npm i -D extension@4.1.36"));

    expect(warning).toBeDefined();

    for (const shell of SHELLS) {
      expect(landsIn(shell, cdWord(result.value.manualAlternative))).toBe(dir);
      expect(landsIn(shell, cdWord(warning!))).toBe(dir);
    }
  });
});
