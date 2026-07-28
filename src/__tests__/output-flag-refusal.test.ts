import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface CliResponse {
  code: number;
  stdout: string;
  stderr: string;
}

const cliCalls: string[][] = [];
let cliResponder: ((args: string[]) => CliResponse) | null = null;

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cliCalls.push(args);
      return cliResponder?.(args) ?? { code: 0, stdout: "", stderr: "" };
    },
  };
});

const engineVersion = await import("../lib/engine-version");
const act = await import("../lib/act");
const doctor = await import("../tools/doctor");

const UNKNOWN_OUTPUT = "error: unknown option '--output'";

const tmpDirs: string[] = [];

/* @invariant The probe reads the project's OWN binary, so a project without one resolves
   to `npx extension@<pin>` and answers from the pin without spawning anything.
   These tests are about what a project's installed engine says, so they give it
   a binary to resolve and let the mocked exec answer for it. */
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

function engineThatRefusesTheFlag(version: string | null) {
  return (args: string[]): CliResponse => {
    if (args[0] === "--version") {
      return version === null
        ? { code: 1, stdout: "", stderr: "not a version" }
        : { code: 0, stdout: `${version}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: UNKNOWN_OUTPUT };
  };
}

const probeCalls = () => cliCalls.filter((args) => args[0] === "--version");

beforeEach(() => {
  engineVersion.resetEngineVersionCache();
});

afterEach(() => {
  cliCalls.length = 0;
  cliResponder = null;
  engineVersion.resetEngineVersionCache();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* @invariant `--output json` is a flag this server adds behind the caller's back, so an
   engine that refuses it produces an error about something the user never did.
   build answers that by rebuilding without the flag; doctor and the act family
   have no second source and can only answer with a truthful diagnosis. These
   pin that the diagnosis names the two numbers that decide what to do. */
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

  /* @invariant A version at or above the floor that still refuses the flag is not a user
     who needs to upgrade; it is a binary that is not what it claims to be.
     Telling them to upgrade would send them round a loop with no exit. */
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
