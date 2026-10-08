import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ExecModule from "../lib/exec";

interface CliResponse {
  code: number;
  stdout: string;
  stderr: string;
}

const cliCalls: string[][] = [];
let cliResponder: ((args: string[]) => CliResponse) | null = null;

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cliCalls.push(args);

      return cliResponder?.(args) ?? { code: 0, stdout: "", stderr: "" };
    },
  };
});

let engineVersion = await import("../lib/engine-version");
let act = await import("../lib/act");
let doctor = await import("../tools/doctor");

const UNKNOWN_OUTPUT = "error: unknown option '--output'";
const UNKNOWN_OUTPUT_REDESIGNED =
  "⏵⏵⏵ Unknown option --output.\nRun extension doctor --help to see the options.";

const tmpDirs: string[] = [];

function projectWithLocalEngine(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-refusal-"));
  tmpDirs.push(dir);
  const bin = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  const exe = path.join(
    bin,
    process.platform === "win32" ? "extension.cmd" : "extension",
  );
  fs.writeFileSync(exe, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(exe, 0o755);

  return dir;
}

function engineThatRefusesTheFlag(
  version: string | null,
  refusal: string = UNKNOWN_OUTPUT,
) {
  return (args: string[]): CliResponse => {
    if (args[0] === "capabilities") {
      return {
        code: 1,
        stdout: "",
        stderr: "error: unknown command 'capabilities'",
      };
    }

    if (args[0] === "--version") {
      return version === null
        ? { code: 1, stdout: "", stderr: "not a version" }
        : { code: 0, stdout: `${version}\n`, stderr: "" };
    }

    return { code: 1, stdout: "", stderr: refusal };
  };
}

const probeCalls = () => cliCalls.filter((args) => args[0] === "--version");

beforeEach(async () => {
  vi.resetModules();
  engineVersion = await import("../lib/engine-version");
  act = await import("../lib/act");
  doctor = await import("../tools/doctor");
});

afterEach(() => {
  cliCalls.length = 0;
  cliResponder = null;

  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_doctor explains a refused --output instead of relaying it", () => {
  it("names the installed version and the release the flag reached", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engineThatRefusesTheFlag("4.0.10");

    const out = JSON.parse(await doctor.handler({ projectPath: dir }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("engine-too-old");
    expect(out.error.code).toBe("E_ENGINE_TOO_OLD");
    expect(out.error.message).toContain("4.0.10");
    expect(out.error.message).toContain("4.0.11");
    expect(out.error.message).not.toContain("unknown option");
    expect(probeCalls()).toHaveLength(1);
  });

  it("says the version could not be read rather than inventing one", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engineThatRefusesTheFlag(null);

    const out = JSON.parse(await doctor.handler({ projectPath: dir }));

    expect(out.error.code).toBe("E_ENGINE_TOO_OLD");
    expect(out.error.message).toMatch(/could not be read/);
    expect(out.error.message).toContain("4.0.11");
  });

  it("reads the refusal in its redesigned wording too", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engineThatRefusesTheFlag("4.0.10", UNKNOWN_OUTPUT_REDESIGNED);

    const out = JSON.parse(await doctor.handler({ projectPath: dir }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("engine-too-old");
    expect(out.error.code).toBe("E_ENGINE_TOO_OLD");
    expect(out.error.message).toContain("4.0.10");
    expect(out.error.message).toContain("4.0.11");
    expect(out.error.message.toLowerCase()).not.toContain("unknown option");
  });

  it("keeps the probe off the path where nothing was refused", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = () => ({
      code: 0,
      stdout: JSON.stringify([
        { check: "ready-contract", status: "pass", detail: "ok" },
      ]),
      stderr: "",
    });

    const out = JSON.parse(await doctor.handler({ projectPath: dir }));

    expect(out.ok).toBe(true);
    expect(probeCalls()).toHaveLength(0);
  });
});

describe("the act family explains a refused --output instead of relaying it", () => {
  it("names the verb, the installed version and the act floor", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engineThatRefusesTheFlag("3.18.0");

    const out = JSON.parse(
      await act.runActVerb(["eval", dir], dir, undefined, "extension_eval"),
    );

    expect(out.ok).toBe(false);
    expect(out.status).toBe("engine-too-old");
    expect(out.error.code).toBe("E_ENGINE_TOO_OLD");
    expect(out.error.message).toContain("extension eval");
    expect(out.error.message).toContain("3.18.0");
    expect(out.error.message).toContain("3.18.1");
    expect(out.error.message).not.toContain("unknown option");
  });

  it("reports a refusal from an engine that claims to be new enough as a contradiction", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engineThatRefusesTheFlag("4.0.18");

    const out = JSON.parse(
      await act.runActVerb(["open", "popup", dir], dir, undefined, "extension_open"),
    );

    expect(out.error.code).toBe("E_ENGINE_TOO_OLD");
    expect(out.error.message).toMatch(/not the version it claims to be/);
    expect(out.error.message).toMatch(/node_modules\/\.bin\/extension/);
    expect(out.error.message).not.toMatch(/Upgrade the project's Extension\.js/);
  });

  it("leaves an ordinary CLI failure reported as one", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = (args) =>
      args[0] === "--version"
        ? { code: 0, stdout: "4.0.18\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "no active control channel found" };

    const out = JSON.parse(
      await act.runActVerb(["reload", dir], dir, undefined, "extension_reload"),
    );

    expect(out.status).toBe("cli-failed");
    expect(out.error.code).toBe("E_CLI");
    expect(probeCalls()).toHaveLength(0);
  });
});
