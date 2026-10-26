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
const codesignCalls: string[] = [];

vi.mock("../lib/codesign", async (importOriginal) => {
  const actual = await importOriginal<typeof CodesignModule>();

  return {
    ...actual,
    describeCodeSignature: async (appPath: string) => {
      codesignCalls.push(appPath);

      return codesignAnswer(appPath);
    },
  };
});

const {
  adHocDespiteTeamWarning,
  appPathFromSessionOutput,
  identityChangedHint,
  parseCodesignIdentity,
  recordSigningIdentity,
  safariAppPath,
  safariSigningFrame,
} = await import("../lib/safari-signing");

const TEAM_SIGNED = [
  "Executable=/x/Leon.app/Contents/MacOS/Leon",
  "Identifier=com.cezaraugusto.leon",
  "CodeDirectory v=20500 size=545 flags=0x10000(runtime) hashes=6+7 location=embedded",
  "Signature size=4801",
  "Authority=Apple Development: CEZAR AUGUSTO (62ZL6K4MM4)",
  "TeamIdentifier=JU3XAJJQ2G",
].join("\n");

const AD_HOC = [
  "Executable=/x/Leon.app/Contents/MacOS/Leon",
  "Identifier=com.cezaraugusto.leon",
  "CodeDirectory v=20400 size=356 flags=0x2(adhoc) hashes=5+2 location=embedded",
  "Signature=adhoc",
  "TeamIdentifier=not set",
].join("\n");

const XCODEBUILD_LINE =
  "    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -project /w/leon/dist/safari-xcode/Leon/Leon.xcodeproj -scheme Leon -configuration Release -derivedDataPath /w/leon/dist/safari-xcode/.derived DEVELOPMENT_TEAM=62ZL6K4MM4 CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates build";

const NO_ACCOUNT_LINE =
  '/w/leon/dist/safari-xcode/Leon/Leon.xcodeproj: error: No Account for Team "62ZL6K4MM4". Add a new account in Accounts settings or verify that your accounts have valid credentials. (in target \'Leon Extension\' from project \'Leon\')';

let dir: string;

function appDir(appName: string): string {
  const app = path.join(dir, "dist", "safari-xcode", ".derived", "Build", "Products", "Release", `${appName}.app`);
  fs.mkdirSync(app, { recursive: true });

  return app;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-safari-signing-"));
  codesignCalls.length = 0;
  codesignAnswer = () => null;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("codesign output is read into one identity", () => {
  it("reads a team signature, an ad-hoc signature, and answers unknown for anything else", () => {
    expect(parseCodesignIdentity(TEAM_SIGNED)).toBe("team:JU3XAJJQ2G");
    expect(parseCodesignIdentity(AD_HOC)).toBe("ad-hoc");
    expect(parseCodesignIdentity(null)).toBe("unknown");
    expect(parseCodesignIdentity("Leon.app: code object is not signed at all")).toBe("unknown");
  });

  it("finds the app from the xcodebuild line the engine printed into the session log", () => {
    expect(appPathFromSessionOutput(XCODEBUILD_LINE)).toBe("/w/leon/dist/safari-xcode/.derived/Build/Products/Release/Leon.app");
    expect(appPathFromSessionOutput(XCODEBUILD_LINE.replace(/\/w\/leon\/dist\/safari-xcode/g, "C:\\w\\leon\\dist\\safari-xcode"))).toBe(
      "C:\\w\\leon\\dist\\safari-xcode\\.derived\\Build\\Products\\Release\\Leon.app",
    );

    expect(appPathFromSessionOutput("compiled in 830 ms")).toBeNull();
  });

  it("falls back to the engine's layout under dist/<browser>-xcode with the manifest name sanitized the engine's way", () => {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ name: "Leon: blur/faces" }));

    expect(safariAppPath(dir, "safari", {})).toBe(
      path.join(dir, "dist", "safari-xcode", ".derived", "Build", "Products", "Release", "Leon blur faces.app"),
    );

    expect(safariAppPath(dir, "safari", { appName: "Custom" })).toBe(
      path.join(dir, "dist", "safari-xcode", ".derived", "Build", "Products", "Release", "Custom.app"),
    );

    expect(safariAppPath(dir, "safari", { sessionOutput: XCODEBUILD_LINE })).toBe(
      "/w/leon/dist/safari-xcode/.derived/Build/Products/Release/Leon.app",
    );
  });
});

describe("the signing frame", () => {
  it("answers nothing for a browser that is not Safari", async () => {
    expect(await safariSigningFrame(dir, "chrome", { requested: "JU3XAJJQ2G" })).toBeNull();
    expect(codesignCalls).toHaveLength(0);
  });

  it("answers unknown, calls no codesign and makes no claim when the app is not on disk", async () => {
    const frame = await safariSigningFrame(dir, "safari", { requested: "62ZL6K4MM4", appName: "Leon" });

    expect(frame?.signing).toEqual({ requested: "62ZL6K4MM4", identity: "unknown", appPath: expect.stringMatching(/Leon\.app$/) });
    expect(frame?.warnings).toEqual([]);
    expect(frame?.hints).toEqual([]);
    expect(codesignCalls).toHaveLength(0);
  });

  it("answers unknown when codesign cannot read the app", async () => {
    appDir("Leon");
    codesignAnswer = () => null;

    const frame = await safariSigningFrame(dir, "safari", { requested: "62ZL6K4MM4", appName: "Leon" });

    expect(frame?.signing.identity).toBe("unknown");
    expect(frame?.warnings).toEqual([]);
    expect(codesignCalls).toHaveLength(1);
  });

  it("warns when a team was requested but the app is ad-hoc, naming the No Account for Team line the log carries", async () => {
    const app = appDir("Leon");
    codesignAnswer = () => AD_HOC;
    const logPath = path.join(dir, "session.log");
    const xcodebuildLine = XCODEBUILD_LINE.replace(/\/w\/leon\/dist\/safari-xcode/g, path.join(dir, "dist", "safari-xcode"));
    fs.writeFileSync(logPath, `${xcodebuildLine}\n${NO_ACCOUNT_LINE}\n`);

    const frame = await safariSigningFrame(dir, "safari", { requested: "62ZL6K4MM4", appName: "Leon", logPath, sessionPid: 11 });

    expect(frame?.signing).toEqual({
      requested: "62ZL6K4MM4",
      identity: "ad-hoc",
      appPath: app,
    });

    expect(frame?.warnings).toEqual([adHocDespiteTeamWarning("62ZL6K4MM4", NO_ACCOUNT_LINE)]);
    expect(frame?.warnings[0]).toContain('Xcode has no account for team 62ZL6K4MM4: xcodebuild printed "No Account for Team" in this session\'s log.');
    expect(frame?.warnings[0]).toContain("sign in to Xcode with that team's Apple ID");
    expect(frame?.warnings[0]).toContain("set developmentTeam to a team Xcode already knows, or drop developmentTeam for an ad-hoc build");
    expect(frame?.warnings[0]).not.toMatch(/storage/);
  });

  it("names the likely cause when the log carries no No Account for Team line", async () => {
    appDir("Leon");
    codesignAnswer = () => AD_HOC;

    const frame = await safariSigningFrame(dir, "safari", { requested: "62ZL6K4MM4", appName: "Leon", sessionPid: 12 });

    expect(frame?.warnings[0]).toContain("the likely cause is that Xcode has no account for team 62ZL6K4MM4");
    expect(frame?.warnings[0]).toContain('xcodebuild prints "No Account for Team" when that is so');
  });

  it("warns when the app is signed by a team other than the requested one, and not when they match", async () => {
    appDir("Leon");
    codesignAnswer = () => TEAM_SIGNED;

    const other = await safariSigningFrame(dir, "safari", { requested: "62ZL6K4MM4", appName: "Leon", sessionPid: 13 });
    expect(other?.signing.identity).toBe("team:JU3XAJJQ2G");
    expect(other?.warnings[0]).toContain("developmentTeam 62ZL6K4MM4 was requested, but the built app is signed by team JU3XAJJQ2G");

    const same = await safariSigningFrame(dir, "safari", { requested: "JU3XAJJQ2G", appName: "Leon", sessionPid: 13 });
    expect(same?.warnings).toEqual([]);

    const none = await safariSigningFrame(dir, "safari", { appName: "Leon", sessionPid: 13 });
    expect(none?.signing.requested).toBeNull();
    expect(none?.warnings).toEqual([]);
  });

  it("says the extension must be enabled again when the identity differs from the previous run, and only then", async () => {
    appDir("Leon");
    codesignAnswer = () => TEAM_SIGNED;

    const first = await safariSigningFrame(dir, "safari", { appName: "Leon", sessionPid: 21 });
    expect(first?.hints).toEqual([]);

    const again = await safariSigningFrame(dir, "safari", { appName: "Leon", sessionPid: 21 });
    expect(again?.hints).toEqual([]);

    codesignAnswer = () => AD_HOC;
    const changed = await safariSigningFrame(dir, "safari", { appName: "Leon", sessionPid: 22 });
    expect(changed?.hints).toEqual([identityChangedHint("team:JU3XAJJQ2G", "ad-hoc")]);
    expect(changed?.hints[0]).toContain("The app's signing identity changed since the previous run (team:JU3XAJJQ2G before, ad-hoc now). Safari treats the newly signed app as a new extension, so it must be enabled again");
    expect(changed?.hints[0]).toContain("enableExtension: true does that without a Settings trip");
    expect(changed?.hints[0]).not.toMatch(/storage\.local|resets? the extension/);

    const sameSessionAgain = await safariSigningFrame(dir, "safari", { appName: "Leon", sessionPid: 22 });
    expect(sameSessionAgain?.hints).toEqual([identityChangedHint("team:JU3XAJJQ2G", "ad-hoc")]);

    const next = await safariSigningFrame(dir, "safari", { appName: "Leon", sessionPid: 23 });
    expect(next?.hints).toEqual([]);
  });

  it("never records an unknown identity, so a run that could not be read does not fake a change", () => {
    expect(recordSigningIdentity(dir, "safari", "team:JU3XAJJQ2G", 31)).toBeNull();
    expect(recordSigningIdentity(dir, "safari", "unknown", 32)).toBeNull();
    expect(recordSigningIdentity(dir, "safari", "ad-hoc", 33)).toBe("team:JU3XAJJQ2G");
  });
});
