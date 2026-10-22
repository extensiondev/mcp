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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type * as CodesignModule from "../lib/codesign";

let codesignAnswer: (appPath: string) => string | null = () => null;

vi.mock("../lib/codesign", async (importOriginal) => {
  const actual = await importOriginal<typeof CodesignModule>();

  return {
    ...actual,
    describeCodeSignature: async (appPath: string) => codesignAnswer(appPath),
  };
});

const { handler } = await import("../tools/wait");
const { registerSession, removeSession, removeSessionMarker } = await import("../lib/process-manager");
const { recordSigningIdentity } = await import("../lib/safari-signing");
const { writeCompiledUnattachedContract, writeModernContract } = await import("./fixtures/ready-contract");

const AD_HOC = "CodeDirectory v=20400 size=356 flags=0x2(adhoc) hashes=5+2 location=embedded\nSignature=adhoc\nTeamIdentifier=not set\n";
const TEAM_SIGNED = "Signature size=4801\nTeamIdentifier=JU3XAJJQ2G\n";
const NO_ACCOUNT_LINE =
  '/w/leon/dist/safari-xcode/Leon/Leon.xcodeproj: error: No Account for Team "62ZL6K4MM4". Add a new account in Accounts settings or verify that your accounts have valid credentials. (in target \'Leon\' from project \'Leon\')';

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wait-safari-signing-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ name: "Leon" }));
  fs.mkdirSync(path.join(dir, "dist", "safari-xcode", ".derived", "Build", "Products", "Release", "Leon.app"), { recursive: true });
  logPath = path.join(dir, "session.log");
  fs.writeFileSync(logPath, "");
  codesignAnswer = () => null;
});

afterEach(() => {
  for (const browser of ["chrome", "safari"]) {
    removeSession(dir, browser);
    removeSessionMarker(dir, browser);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_wait reads the Safari app's signing from the session it already records", () => {
  it("carries signing on the ready answer and warns when the recorded team was not honored", async () => {
    registerSession({ pid: process.pid, browser: "safari", projectPath: dir, command: "dev", developmentTeam: "62ZL6K4MM4", logPath });
    fs.writeFileSync(logPath, `${NO_ACCOUNT_LINE}\n`);
    writeModernContract(dir, "safari", { pid: process.pid, cdpPort: undefined });
    codesignAnswer = () => AD_HOC;

    const result = JSON.parse(await handler({ projectPath: dir, browser: "safari", timeoutMs: 1500 }));

    expect(result.status).toBe("ready");
    expect(result.value.signing).toEqual({
      requested: "62ZL6K4MM4",
      identity: "ad-hoc",
      appPath: path.join(dir, "dist", "safari-xcode", ".derived", "Build", "Products", "Release", "Leon.app"),
    });

    const warning = (result.warnings as string[]).find((line) => line.startsWith("developmentTeam 62ZL6K4MM4 was requested"));
    expect(warning).toContain('Xcode has no account for team 62ZL6K4MM4: xcodebuild printed "No Account for Team" in this session\'s log.');
    expect(warning).toContain("drop developmentTeam for an ad-hoc build");
    expect(result.hint).toBeUndefined();
  }, 10_000);

  it("says the extension must be enabled again on a compiled-not-attached answer whose identity changed since the previous run", async () => {
    registerSession({ pid: process.pid, browser: "safari", projectPath: dir, command: "dev", logPath });
    recordSigningIdentity(dir, "safari", "ad-hoc", 4242);
    writeCompiledUnattachedContract(dir, "safari", { pid: process.pid });
    codesignAnswer = () => TEAM_SIGNED;

    const result = JSON.parse(await handler({ projectPath: dir, browser: "safari", timeoutMs: 1500 }));

    expect(result.status).toBe("compiled-not-attached");
    expect(result.value.signing).toEqual({ requested: null, identity: "team:JU3XAJJQ2G", appPath: expect.stringMatching(/Leon\.app$/) });
    expect(result.hint).toContain("The extension is not enabled in Safari yet");
    expect(result.hint).toContain("The app's signing identity changed since the previous run (ad-hoc before, team:JU3XAJJQ2G now). Safari treats the newly signed app as a new extension, so it must be enabled again");
    expect(result.hint).toContain("enableExtension: true does that without a Settings trip");
    expect(result.hint).not.toMatch(/storage\.local|resets? the extension/);
    expect(result.warnings.some((line: string) => line.startsWith("developmentTeam"))).toBe(false);
  }, 10_000);

  it("carries no signing for a Chromium session", async () => {
    registerSession({ pid: process.pid, browser: "chrome", projectPath: dir, command: "dev" });
    writeCompiledUnattachedContract(dir, "chrome", { pid: process.pid });

    const result = JSON.parse(await handler({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }));

    expect(result.status).toBe("compiled-not-attached");
    expect(result.value.signing).toBeUndefined();
    expect(result.hint).not.toContain("signing identity");
  }, 10_000);
});
