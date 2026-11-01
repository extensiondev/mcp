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

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handler } from "../tools/wait";
import { registerSession, removeSession, removeSessionMarker } from "../lib/process-manager";
import {
  findXcodebuildUnder,
  parseElapsedMs,
  parseSafariAppStage,
  safariNotAttachedHint,
  xcodebuildProbe,
} from "../lib/safari-app-stage";
import { writeCompiledUnattachedContract } from "./fixtures/ready-contract";

const CONVERTING = "Converting the web extension into a Safari app project…\n";
const GENERATED = "Generated the Safari Xcode project.\n";
const BUILDING = "Building the Safari app with xcodebuild (scheme Rebeccat)…\n";
const BUILT = "Built the Safari app.\n/w/dist/safari-xcode/.derived/Build/Products/Release/Rebeccat.app\n";

const realProcessTable = xcodebuildProbe.processTable;
let dir: string;

function psTable(root: number): string {
  return [
    `  ${root}     1   10:00 node extension dev`,
    `  ${root + 1} ${root}   04:12 /bin/sh -c xcodebuild`,
    `  ${root + 2} ${root + 1}   04:12 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -project Rebeccat.xcodeproj`,
    "  999999     1   1-00:00:01 /usr/bin/xcodebuild -project Other.xcodeproj",
  ].join("\n");
}

function sessionWithLog(log: string): void {
  const logPath = path.join(dir, "session.log");
  fs.writeFileSync(logPath, log);
  registerSession({ pid: process.pid, browser: "safari", projectPath: dir, command: "dev", enableExtension: true, logPath });
  writeCompiledUnattachedContract(dir, "safari", { pid: process.pid });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wait-safari-building-"));
  xcodebuildProbe.processTable = () => psTable(process.pid);
});

afterEach(() => {
  xcodebuildProbe.processTable = realProcessTable;
  removeSession(dir, "safari");
  removeSessionMarker(dir, "safari");
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the Safari app stage read off the session log", () => {
  it("answers the latest stage the engine printed", () => {
    expect(parseSafariAppStage(CONVERTING)).toBe("converting");
    expect(parseSafariAppStage(CONVERTING + GENERATED + BUILDING)).toBe("building");
    expect(parseSafariAppStage(CONVERTING + BUILDING + BUILT)).toBe("built");
    expect(parseSafariAppStage(BUILDING + BUILT + BUILDING)).toBe("building");
    expect(parseSafariAppStage(`${BUILDING}Safari packaging tool xcodebuild exited 65\n`)).toBe("failed");
    expect(parseSafariAppStage("compiled in 120 ms\n")).toBeNull();
  });

  it("finds the xcodebuild under the session pid and how long it has run, not one under another tree", () => {
    expect(findXcodebuildUnder(psTable(500), 500)).toEqual({ pid: 502, elapsedMs: 252_000 });
    expect(findXcodebuildUnder(psTable(500), 4242)).toBeNull();
    expect(parseElapsedMs("1-02:03:04")).toBe(((26 * 60 + 3) * 60 + 4) * 1000);
    expect(parseElapsedMs("not a time")).toBeNull();
  });
});

describe("extension_wait on a Safari session whose app is still building (ledger 344)", () => {
  it("answers building-app with the xcodebuild time, not the enable step's Accessibility advice", async () => {
    sessionWithLog(CONVERTING + GENERATED + BUILDING);

    const result = JSON.parse(await handler({ projectPath: dir, browser: "safari", timeoutMs: 1500 }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("building-app");
    expect(result.error.code).toBe("E_SAFARI_APP_BUILDING");
    expect(result.value.appStage).toBe("building");
    expect(result.value.xcodebuildPid).toBe(process.pid + 2);
    expect(result.value.xcodebuildElapsedMs).toBe(252_000);
    expect(result.hint).toContain("running for 252 s");
    expect(result.hint).toContain("Safari opens when the Xcode build finishes");
    expect(result.hint).toContain("Call extension_wait again");
    expect(result.hint).not.toContain("not enabled in Safari yet");
    expect(result.hint).not.toContain("Accessibility");
  }, 10_000);

  it("keeps the enable step's advice once the engine printed that the app was built", async () => {
    sessionWithLog(CONVERTING + BUILDING + BUILT);

    const result = JSON.parse(await handler({ projectPath: dir, browser: "safari", timeoutMs: 1500 }));

    expect(result.status).toBe("compiled-not-attached");
    expect(result.hint).toContain("The extension is not enabled in Safari yet");
    expect(result.hint).toContain("Accessibility");
  }, 10_000);

  it("gives extension_dev's not-ready line the same building sentence", () => {
    sessionWithLog(CONVERTING);

    expect(safariNotAttachedHint(dir, "safari", true)).toContain("still converting the extension into a Safari app project");
    expect(safariNotAttachedHint(dir, "safari", true)).not.toContain("not enabled in Safari yet");
    expect(safariNotAttachedHint(dir, "chrome", false)).toContain("usually transient");
  });
});
