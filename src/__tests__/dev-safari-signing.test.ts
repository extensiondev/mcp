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
import { spawn } from "node:child_process";

import { describe, it, expect, vi, afterEach } from "vitest";

import type { ChildProcess } from "node:child_process";
import type * as ExecModule from "../lib/exec";
import type { SpawnedCli } from "../lib/exec";
import type * as CodesignModule from "../lib/codesign";
import type * as WaitModule from "../tools/wait";
import type * as LogsModule from "../tools/logs";

const spawned: ChildProcess[] = [];
let plantedOutput = "";
let codesignAnswer: (appPath: string) => string | null = () => null;

const AD_HOC = "CodeDirectory v=20400 size=356 flags=0x2(adhoc) hashes=5+2 location=embedded\nSignature=adhoc\nTeamIdentifier=not set\n";
const TEAM_SIGNED = "Signature size=4801\nAuthority=Apple Development: CEZAR AUGUSTO (62ZL6K4MM4)\nTeamIdentifier=JU3XAJJQ2G\n";
const NO_ACCOUNT_LINE =
  '/w/leon/dist/safari-xcode/Leon/Leon.xcodeproj: error: No Account for Team "62ZL6K4MM4". Add a new account in Accounts settings or verify that your accounts have valid credentials. (in target \'Leon\' from project \'Leon\')';

function fakeCli(): SpawnedCli {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-cli-"));
  const logPath = path.join(logDir, "session.log");
  fs.writeFileSync(logPath, plantedOutput);
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  spawned.push(child);

  return {
    child,
    logPath,
    readOutput: () => {
      try {
        return fs.readFileSync(logPath, "utf8");
      } catch {
        return "";
      }
    },
  };
}

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    spawnExtensionCli: () => fakeCli(),
  };
});

vi.mock("../lib/codesign", async (importOriginal) => {
  const actual = await importOriginal<typeof CodesignModule>();

  return {
    ...actual,
    describeCodeSignature: async (appPath: string) => codesignAnswer(appPath),
  };
});

let waitAnswer = (): string =>
  JSON.stringify({ ok: true, status: "ready", value: { compiled: true, browserAttached: true, guestLoaded: null } });

vi.mock("../tools/wait", async (importOriginal) => {
  const actual = await importOriginal<typeof WaitModule>();

  return {
    ...actual,
    handler: async () => waitAnswer(),
  };
});

vi.mock("../tools/logs", async (importOriginal) => {
  const actual = await importOriginal<typeof LogsModule>();

  return {
    ...actual,
    handler: async () => JSON.stringify({ ok: true, status: "ok", value: { count: 0, lines: [] } }),
  };
});

const dev = await import("../tools/dev");
const { findSessionInfo, removeSession, removeSessionMarker } = await import("../lib/process-manager");
const { recordSigningIdentity } = await import("../lib/safari-signing");

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-safari-signing-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ name: "Leon", version: "0.1.0" }));
  fs.mkdirSync(path.join(dir, "dist", "safari-xcode", ".derived", "Build", "Products", "Release", "Leon.app"), { recursive: true });

  return dir;
}

afterEach(() => {
  plantedOutput = "";
  codesignAnswer = () => null;
  waitAnswer = () =>
    JSON.stringify({ ok: true, status: "ready", value: { compiled: true, browserAttached: true, guestLoaded: null } });

  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  for (const dir of tmpDirs.splice(0)) {
    for (const browser of ["chrome", "safari"]) {
      try {
        removeSession(dir, browser);
        removeSessionMarker(dir, browser);
      } catch {
      }
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_dev for Safari says how the built app was signed", () => {
  it("carries signing from codesign and warns when the requested team was not honored, naming the No Account for Team line", async () => {
    const project = tmpProject();
    plantedOutput = `${NO_ACCOUNT_LINE}\n`;
    codesignAnswer = () => AD_HOC;

    const result = JSON.parse(await dev.handler({ projectPath: project, browser: "safari", developmentTeam: "62ZL6K4MM4" }));

    expect(result.status).toBe("started");
    expect(result.value.signing).toEqual({
      requested: "62ZL6K4MM4",
      identity: "ad-hoc",
      appPath: path.join(project, "dist", "safari-xcode", ".derived", "Build", "Products", "Release", "Leon.app"),
    });

    const warning = (result.warnings as string[]).find((line) => line.startsWith("developmentTeam 62ZL6K4MM4 was requested"));
    expect(warning).toContain("the built app is ad-hoc signed (codesign reads Signature=adhoc)");
    expect(warning).toContain('Xcode has no account for team 62ZL6K4MM4: xcodebuild printed "No Account for Team" in this session\'s log.');
    expect(warning).toContain("sign in to Xcode with that team's Apple ID (Xcode > Settings > Accounts), set developmentTeam to a team Xcode already knows, or drop developmentTeam for an ad-hoc build");
    expect(result.hint).not.toContain("signing identity changed");

    const marker = findSessionInfo(project, "safari");
    expect(marker?.developmentTeam).toBe("62ZL6K4MM4");
    expect(marker?.logPath).toBe(result.value.logPath);
  }, 15_000);

  it("says Safari treats the newly signed app as a new extension when the identity differs from the previous run", async () => {
    const project = tmpProject();
    recordSigningIdentity(project, "safari", "team:JU3XAJJQ2G", 4242);
    codesignAnswer = () => AD_HOC;

    const result = JSON.parse(await dev.handler({ projectPath: project, browser: "safari" }));

    expect(result.value.signing).toEqual({ requested: null, identity: "ad-hoc", appPath: expect.stringMatching(/Leon\.app$/) });
    expect(result.warnings.some((line: string) => line.startsWith("developmentTeam"))).toBe(false);
    expect(result.hint).toContain("The app's signing identity changed since the previous run (team:JU3XAJJQ2G before, ad-hoc now). Safari treats the newly signed app as a new extension, so it must be enabled again");
    expect(result.hint).toContain("enableExtension: true does that without a Settings trip");
    expect(result.hint).not.toMatch(/storage\.local|resets? the extension/);
  }, 15_000);

  it("carries the identity on a compiled-not-attached answer beside the not-enabled hint, and strips wait's own copy", async () => {
    const project = tmpProject();
    codesignAnswer = () => TEAM_SIGNED;
    waitAnswer = () =>
      JSON.stringify({
        ok: false,
        status: "compiled-not-attached",
        value: { compiled: true, browserAttached: false, signing: { requested: "JU3XAJJQ2G", identity: "team:JU3XAJJQ2G" } },
      });

    const result = JSON.parse(await dev.handler({ projectPath: project, browser: "safari", developmentTeam: "JU3XAJJQ2G", appName: "Leon" }));

    expect(result.value.ready.status).toBe("compiled-not-attached");
    expect(result.value.ready.signing).toBeUndefined();
    expect(result.value.signing).toEqual({ requested: "JU3XAJJQ2G", identity: "team:JU3XAJJQ2G", appPath: expect.stringMatching(/Leon\.app$/) });
    expect(result.warnings.some((line: string) => line.startsWith("developmentTeam"))).toBe(false);
    expect(result.hint).toContain("The extension is not enabled in Safari yet");
  }, 15_000);

  it("answers unknown and no claim when the app cannot be read, and nothing at all for another browser or an unawaited start", async () => {
    const unreadable = tmpProject();
    fs.rmSync(path.join(unreadable, "dist"), { recursive: true, force: true });

    const unknown = JSON.parse(await dev.handler({ projectPath: unreadable, browser: "safari", developmentTeam: "62ZL6K4MM4" }));
    expect(unknown.value.signing.identity).toBe("unknown");
    expect(unknown.warnings.some((line: string) => line.startsWith("developmentTeam"))).toBe(false);

    const chrome = JSON.parse(await dev.handler({ projectPath: tmpProject() }));
    expect(chrome.value.signing).toBeUndefined();

    codesignAnswer = () => AD_HOC;
    const unawaited = JSON.parse(await dev.handler({ wait: false, projectPath: tmpProject(), browser: "safari", developmentTeam: "62ZL6K4MM4" }));
    expect(unawaited.status).toBe("started");
    expect(unawaited.value.signing).toBeUndefined();
  }, 20_000);
});
