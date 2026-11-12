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
import { safariEnableFrame, safariEnableProbes } from "../lib/safari-enable-read";
import { parseSafariExtensionsPlist, safariExtensionsPlistPath } from "../lib/safari-extensions-plist";
import { posixPath } from "../lib/session-paths";
import { writeCompiledUnattachedContract } from "./fixtures/ready-contract";
import { AD_HOC_CODESIGN, extensionsPlistXml, TEAM, TEAM_SIGNED_CODESIGN } from "./fixtures/safari-extensions-plist";

const ID = "com.acme.visionario.Extension";
const BUILT = "Building the Safari app with xcodebuild (scheme Visionario)…\nBuilt the Safari app.\n";
const SETTINGS_DID_NOT_OPEN = "Couldn't finish enabling Visionario in Safari: Safari Settings did not open\nFinish the steps below by hand.\n";

const saved = { ...safariEnableProbes };
let dir: string;
let appPath: string;
let automationCalls: number;

function listing(mark: string): string {
  const appex = path.join(path.dirname(appPath), "Visionario.app", "Contents", "PlugIns", "Visionario Extension.appex");

  return `${mark}    ${ID}(1.0)\t3E3BBEFD-8E88-414A-B1B4-4BA28401048E\t2026-11-06 18:15:33 +0000\t${appex}\n (1 plug-in)\n`;
}

function session(log: string = BUILT + SETTINGS_DID_NOT_OPEN): void {
  const logPath = path.join(dir, "session.log");
  fs.writeFileSync(logPath, log);
  registerSession({ pid: process.pid, browser: "safari", projectPath: dir, command: "dev", enableExtension: true, logPath });
  writeCompiledUnattachedContract(dir, "safari", { pid: process.pid, extensionId: ID, extensionName: "Visionario", binary: appPath });
}

function builtFiles(manifest: Record<string, unknown>, scripts: Record<string, string> = {}): void {
  const dist = path.join(dir, "dist", "safari");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Visionario", version: "1.0", ...manifest }));

  for (const [file, source] of Object.entries(scripts)) {
    fs.mkdirSync(path.dirname(path.join(dist, file)), { recursive: true });
    fs.writeFileSync(path.join(dist, file), source);
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-safari-enable-plist-"));
  appPath = path.join(dir, "dist", "safari-xcode", ".derived", "Build", "Products", "Release", "Visionario.app");
  fs.mkdirSync(appPath, { recursive: true });
  automationCalls = 0;
  safariEnableProbes.platform = () => "darwin";

  safariEnableProbes.automation = () => {
    automationCalls += 1;

    return { ok: true, detail: "" };
  };

  safariEnableProbes.safariRunning = () => true;
  safariEnableProbes.pluginkitList = () => listing(" ");
  safariEnableProbes.codesign = () => AD_HOC_CODESIGN;
  safariEnableProbes.extensionsPlist = () => ({ xml: extensionsPlistXml([{ id: ID, identity: "UNSIGNED" }]), reason: "" });
  safariEnableProbes.hostApp = () => "iTerm";
});

afterEach(() => {
  Object.assign(safariEnableProbes, saved);
  removeSession(dir, "safari");
  removeSessionMarker(dir, "safari");
  fs.rmSync(dir, { recursive: true, force: true });
});

async function wait(): Promise<Record<string, any>> {
  return JSON.parse(await handler({ projectPath: dir, browser: "safari", timeoutMs: 1500 })) as Record<string, any>;
}

describe("Safari's WebExtensions Extensions.plist", () => {
  it("reads one row per signing identity, an absent Enabled key as off, a RemovedDate as retired, and the dates", () => {
    const rows = parseSafariExtensionsPlist(
      extensionsPlistXml([
        { id: ID, identity: TEAM, enabled: true, addedAt: "2026-11-06T17:55:22Z" },
        { id: ID, identity: "UNSIGNED" },
        { id: "dev.extensionjs.Hands-free.Extension", identity: TEAM, enabled: true, removedAt: "2026-11-06T18:00:00Z" },
      ]),
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ bundleId: ID, identity: TEAM, enabled: true, removed: false, addedAt: "2026-11-06T17:55:22Z", enabledChangedAt: "2026-11-06T18:25:36Z", removedAt: null });
    expect(rows[1]).toMatchObject({ bundleId: ID, identity: "UNSIGNED", enabled: false, removed: false, enabledChangedAt: null });
    expect(rows[2]).toMatchObject({ bundleId: "dev.extensionjs.Hands-free.Extension", enabled: false, removed: true, removedAt: "2026-11-06T18:00:00Z" });
    expect(parseSafariExtensionsPlist("<plist version=\"1.0\"><dict/></plist>")).toEqual([]);
    expect(parseSafariExtensionsPlist("not a plist")).toEqual([]);
    expect(safariExtensionsPlistPath("/Users/pat")).toBe("/Users/pat/Library/Containers/com.apple.Safari/Data/Library/Safari/WebExtensions/Extensions.plist");
  });

  it("builds the plist path with forward slashes on every OS, from a Windows-style home and from the real one (ledger 549)", () => {
    expect(safariExtensionsPlistPath("C:\\Users\\pat")).toBe("C:/Users/pat/Library/Containers/com.apple.Safari/Data/Library/Safari/WebExtensions/Extensions.plist");
    expect(safariExtensionsPlistPath("C:\\Users\\pat\\")).toBe("C:/Users/pat/Library/Containers/com.apple.Safari/Data/Library/Safari/WebExtensions/Extensions.plist");
    expect(safariExtensionsPlistPath()).toBe(`${posixPath(os.homedir())}/Library/Containers/com.apple.Safari/Data/Library/Safari/WebExtensions/Extensions.plist`);
    expect(safariExtensionsPlistPath()).not.toContain("\\");
  });
});

describe("extension_wait on a Safari build Extensions.plist knows under more than one signing identity (ledger 452)", () => {
  it("says Safari runs the stale team-signed copy when that row is on beside a fresh unsigned build, and names the team-signed rebuild", async () => {
    session();
    safariEnableProbes.extensionsPlist = () => ({ xml: extensionsPlistXml([{ id: ID, identity: TEAM, enabled: true }, { id: ID, identity: "UNSIGNED" }]), reason: "" });

    const result = await wait();

    expect(result.status).toBe("compiled-not-attached");
    expect(result.value.safari).toMatchObject({ enabled: false, source: "extensions-plist", identity: "UNSIGNED", bundleId: ID, unknownReason: null });
    expect(result.value.safari.rows.map((row: { identity: string; enabled: boolean }) => [row.identity, row.enabled])).toEqual([[TEAM, true], ["UNSIGNED", false]]);
    expect(result.value.safari.blocker.kind).toBe("other-copy");
    expect(result.value.safari.blocker.detail).toContain(`Safari runs ${ID} (${TEAM}), the copy signed by team ${TEAM}, not the unsigned (ad-hoc) app this build produced at ${appPath}`);
    expect(result.value.safari.blocker.detail).toContain("NSURLError -1100");
    expect(result.value.safari.blocker.fix).toContain(`Rebuild team-signed: call extension_dev again with developmentTeam: "${TEAM}" (xcodebuild DEVELOPMENT_TEAM=${TEAM})`);
    expect(result.value.safari.blocker.fix).toContain(`turn off Visionario (${TEAM}) and turn on Visionario (UNSIGNED)`);
    expect(result.value.safari.retry.args).toMatchObject({ projectPath: dir, browser: "safari", replace: true, enableExtension: true, developmentTeam: TEAM });
    expect(result.hint).toContain(`Visionario is not enabled in Safari (Safari holds ${ID} (UNSIGNED) off). What blocks it: Safari runs ${ID} (${TEAM})`);
    expect(result.hint).not.toContain("Allow unsigned extensions (an ad-hoc");
  }, 10_000);

  it("answers unsigned-row for a fresh unsigned build whose row is off, with the team route and the hand route", () => {
    session();

    const frame = safariEnableFrame(dir, "safari", true);

    expect(frame?.safari).toMatchObject({ enabled: false, identity: "UNSIGNED" });
    expect(frame?.safari.blocker?.kind).toBe("unsigned-row");
    expect(frame?.safari.blocker?.detail).toBe(`Safari holds ${ID} (UNSIGNED) off, and an unsigned row does not switch on by automation (an AX click, AXPress or a CGEvent click leaves it off even with Allow unsigned extensions on), while a team-signed row toggles`);
    expect(frame?.safari.blocker?.fix).toContain("developmentTeam: \"<team>\" (xcodebuild DEVELOPMENT_TEAM=<team>)");
    expect(frame?.safari.blocker?.fix).toContain("or by hand: Safari > Settings > Developer > Allow unsigned extensions, then Safari > Settings > Extensions > turn on Visionario");
    expect(frame?.safari.retry.args).not.toHaveProperty("developmentTeam");

    safariEnableProbes.extensionsPlist = () => ({ xml: extensionsPlistXml([{ id: ID, identity: TEAM, enabled: true, removedAt: "2026-11-06T18:00:00Z" }]), reason: "" });
    const noRow = safariEnableFrame(dir, "safari", true);

    expect(noRow?.safari.blocker?.kind).toBe("unsigned-row");
    expect(noRow?.safari.blocker?.detail).toContain(`Safari lists no row for ${ID} (UNSIGNED) yet`);
    expect(noRow?.safari.blocker?.fix).toContain(`developmentTeam: "${TEAM}"`);
    expect(noRow?.safari.retry.args).toMatchObject({ developmentTeam: TEAM });
    expect(noRow?.hint).toContain(`Safari holds no row for ${ID} (UNSIGNED) yet, only (${TEAM}) off`);
  });

  it("answers enabled from the fresh row even when pluginkit shows it off, and skips the osascript probe", async () => {
    session();
    safariEnableProbes.codesign = () => TEAM_SIGNED_CODESIGN;
    safariEnableProbes.extensionsPlist = () => ({ xml: extensionsPlistXml([{ id: ID, identity: "UNSIGNED" }, { id: ID, identity: TEAM, enabled: true }]), reason: "" });

    const result = await wait();

    expect(result.value.safari).toMatchObject({ enabled: true, source: "extensions-plist", identity: TEAM, bundleId: ID, blocker: null, carriesOver: true });
    expect(result.value.safari.rows).toHaveLength(2);
    expect(result.hint).toContain(`Visionario is enabled in Safari: Extensions.plist holds ${ID} (${TEAM}) on, the signed by team ${TEAM} app this build produced`);
    expect(result.hint).not.toContain("not enabled");
    expect(automationCalls).toBe(0);
  }, 10_000);

  it("falls back to pluginkit with enabled unknown and the reason when the plist cannot be read", async () => {
    session();
    safariEnableProbes.pluginkitList = () => listing("+");
    safariEnableProbes.extensionsPlist = () => ({ xml: null, reason: "/Users/pat/Library/Containers/com.apple.Safari/Data/Library/Safari/WebExtensions/Extensions.plist could not be read: plutil exited 1" });

    const result = await wait();

    expect(result.value.safari).toMatchObject({ enabled: "unknown", source: "pluginkit", bundleId: ID, blocker: null, rows: [] });
    expect(result.value.safari.unknownReason).toContain("Extensions.plist could not be read: plutil exited 1");
    expect(result.value.safari.registeredPath).toContain("Visionario.app/Contents/PlugIns");
    expect(result.hint).toContain("Whether Visionario is enabled in Safari is unknown: /Users/pat/Library");
    expect(result.hint).toContain(`pluginkit lists ${ID} on at Visionario.app, which is the registration, not Safari's own switch`);
    expect(automationCalls).toBe(0);
  }, 10_000);

  it("answers unknown with the reason when codesign cannot name the built app's identity and Safari holds more than one row", () => {
    session();
    safariEnableProbes.codesign = () => null;
    safariEnableProbes.extensionsPlist = () => ({ xml: extensionsPlistXml([{ id: ID, identity: TEAM, enabled: true }, { id: ID, identity: "UNSIGNED" }]), reason: "" });

    const frame = safariEnableFrame(dir, "safari", true);

    expect(frame?.safari).toMatchObject({ enabled: "unknown", source: "extensions-plist", identity: null });
    expect(frame?.safari.unknownReason).toBe(`codesign could not say which signing identity the app at ${appPath} carries, and Safari holds 2 rows for ${ID} (${TEAM} on, UNSIGNED off)`);

    safariEnableProbes.extensionsPlist = () => ({ xml: extensionsPlistXml([{ id: ID, identity: TEAM, enabled: true }]), reason: "" });

    expect(safariEnableFrame(dir, "safari", true)?.safari).toMatchObject({ enabled: true, identity: TEAM });
  });

  it("names the camera prompt as a person step when the built code calls getUserMedia, and geolocation from the manifest", async () => {
    session();
    builtFiles({ permissions: ["storage", "geolocation"] }, { "pages/welcome.js": "const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });" });
    safariEnableProbes.extensionsPlist = () => ({ xml: extensionsPlistXml([{ id: ID, identity: "UNSIGNED", enabled: true }]), reason: "" });

    const result = await wait();

    expect(result.value.safari.enabled).toBe(true);
    expect(result.value.safari.personSteps).toEqual([
      { prompt: "geolocation", askedBy: "manifest permission \"geolocation\"", step: expect.stringContaining("Safari shows its geolocation permission prompt and ignores synthetic clicks on it") },
      { prompt: "camera", askedBy: "pages/welcome.js calls getUserMedia", step: expect.stringContaining("Safari shows its camera permission prompt and ignores synthetic clicks on it") },
    ]);

    expect(result.hint).toContain("a person clicks Allow there (pages/welcome.js calls getUserMedia)");

    builtFiles({ permissions: ["storage"] }, { "pages/welcome.js": "console.log('nothing to ask')", "background.js": "navigator.mediaDevices.getUserMedia({ audio: true })" });
    expect(safariEnableFrame(dir, "safari", true)?.safari.personSteps.map((step) => step.prompt)).toEqual(["microphone"]);

    builtFiles({ permissions: ["storage"] }, { "pages/welcome.js": "console.log('nothing to ask')", "background.js": "" });
    expect(safariEnableFrame(dir, "safari", true)?.safari.personSteps).toEqual([]);
  }, 10_000);
});
