// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import { browserFromCliArgs, writeEngineDist } from "./fixtures/engine-answers";

import type * as ExecModule from "../lib/exec";
import type { CliResult } from "../lib/exec";

const calls: Array<{ args: string[]; timeoutMs: number | undefined }> = [];
let answer: CliResult = { code: 0, stdout: "", stderr: "" };

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[], options?: { timeoutMs?: number }) => {
      calls.push({ args, timeoutMs: options?.timeoutMs });
      if (args[0] === "build" && answer.code === 0) writeEngineDist(args[1]!, browserFromCliArgs(args));

      return answer;
    },
  };
});

const build = await import("../tools/build");
const { recordSigningIdentity } = await import("../lib/safari-signing");
const { xcodeTeamsReader } = await import("../lib/xcode-teams");

const stubbedTeams = xcodeTeamsReader.read;
const tmpDirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-safari-team-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "Hands-free", version: "1.0.0", description: "Hands-free" }),
  );

  return dir;
}

const run = async (args: Parameters<typeof build.handler>[0]) => JSON.parse(await build.handler(args));

function teamFlag(args: string[]): string | null {
  const at = args.indexOf("--development-team");

  return at >= 0 ? args[at + 1]! : null;
}

afterEach(() => {
  calls.length = 0;
  answer = { code: 0, stdout: "", stderr: "" };
  xcodeTeamsReader.read = stubbedTeams;

  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_build takes the Safari signing team extension_dev takes (ledger 351)", () => {
  it("declares developmentTeam in its schema and passes it to the engine", async () => {
    expect(Object.keys(build.schema.inputSchema.properties)).toContain("developmentTeam");

    const result = await run({ projectPath: project(), browser: "safari", developmentTeam: "JU3XAJJQ2G" });

    expect(result.ok).toBe(true);
    expect(teamFlag(calls[0]!.args)).toBe("JU3XAJJQ2G");
  });

  it("keeps the team the project's last Safari app was signed with when none is passed, and says so", async () => {
    const dir = project();
    recordSigningIdentity(dir, "safari", "team:JU3XAJJQ2G", 4321);

    const result = await run({ projectPath: dir, browser: "safari" });

    expect(teamFlag(calls[0]!.args)).toBe("JU3XAJJQ2G");
    expect((result.warnings as string[]).some((line) => line.includes("kept team JU3XAJJQ2G"))).toBe(true);
  });

  it("builds ad-hoc on an empty developmentTeam, and on a project whose last app was ad-hoc", async () => {
    const dir = project();
    recordSigningIdentity(dir, "safari", "team:JU3XAJJQ2G", 4321);
    await run({ projectPath: dir, browser: "safari", developmentTeam: "" });

    const other = project();
    recordSigningIdentity(other, "safari", "ad-hoc", 4321);
    await run({ projectPath: other, browser: "safari" });

    expect(teamFlag(calls[0]!.args)).toBeNull();
    expect(teamFlag(calls[1]!.args)).toBeNull();
  });

  it("refuses developmentTeam on a Chromium build, building nothing", async () => {
    const result = await run({ projectPath: project(), browser: "chrome", developmentTeam: "JU3XAJJQ2G" });

    expect(result.status).toBe("safari-only-option");
    expect(result.value.options).toEqual(["developmentTeam"]);
    expect(calls).toHaveLength(0);
  });
});

describe("a team Xcode has no account for is refused before the build (ledger 347)", () => {
  it("refuses with the teams Xcode knows and the ad-hoc fallback it would have made", async () => {
    xcodeTeamsReader.read = async () => ["JU3XAJJQ2G"];

    const result = await run({ projectPath: project(), browser: "safari", developmentTeam: "62ZL6K4MM4" });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("team-unknown-to-xcode");
    expect(result.error.code).toBe("E_TEAM_UNKNOWN_TO_XCODE");
    expect(result.error.message).toContain("Xcode knows JU3XAJJQ2G");
    expect(result.error.message).toContain("Allow unsigned extensions");
    expect(result.value.signing).toEqual({ requested: "62ZL6K4MM4", status: "would-fall-back-to-ad-hoc" });
    expect(result.hint).toContain('developmentTeam: "JU3XAJJQ2G"');
    expect(calls).toHaveLength(0);
  });

  it("builds when Xcode knows the team, and when Xcode's team list cannot be read", async () => {
    xcodeTeamsReader.read = async () => ["JU3XAJJQ2G"];
    await run({ projectPath: project(), browser: "safari", developmentTeam: "JU3XAJJQ2G" });

    xcodeTeamsReader.read = async () => null;
    await run({ projectPath: project(), browser: "safari", developmentTeam: "62ZL6K4MM4" });

    expect(calls).toHaveLength(2);
  });
});

describe("a Safari build gets a budget sized for a cold Xcode run (ledger 345)", () => {
  it("gives Safari 1200 s and every other browser 180 s", async () => {
    await run({ projectPath: project(), browser: "safari" });
    await run({ projectPath: project(), browser: "chrome" });

    expect(calls[0]!.timeoutMs).toBe(1_200_000);
    expect(calls[1]!.timeoutMs).toBe(180_000);
  });

  it("says the server stopped xcodebuild, and that its BUILD INTERRUPTED line is that stop", async () => {
    answer = { code: null, signal: "SIGTERM", timedOut: true, stdout: "** BUILD INTERRUPTED **\nBuild failed with 1 error", stderr: "" };

    const result = await run({ projectPath: project(), browser: "safari" });

    expect(result.status).toBe("build-timeout");
    expect(result.error.message).toContain("stopped the Safari build after 1200000 ms");
    expect(result.error.message).toContain("xcodebuild did not fail");
    expect(result.error.message).toContain("BUILD INTERRUPTED");
    expect(result.value.budgetMs).toBe(1_200_000);
    expect(result.hint).toContain("1200 s");
    expect(result.hint).not.toContain("fixed at 180 s");
  });
});
