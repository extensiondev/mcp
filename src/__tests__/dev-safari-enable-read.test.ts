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
import { parseSafariEngineSays } from "../lib/safari-enable-log";
import { parsePluginkitList, readSafariEnable, safariEnableFrame, safariEnableProbes } from "../lib/safari-enable-read";
import { writeCompiledUnattachedContract } from "./fixtures/ready-contract";
import { extensionsPlistXml, TEAM, TEAM_SIGNED_CODESIGN } from "./fixtures/safari-extensions-plist";

const NEW_ID = "com.acme.visionario.Extension";
const OLD_ID = "dev.extensionjs.Hands-free.Extension";
const BUILT = "Building the Safari app with xcodebuild (scheme Visionario)…\nBuilt the Safari app.\n";
const SETTINGS_DID_NOT_OPEN = "Couldn't finish enabling Visionario in Safari: Safari Settings did not open\nFinish the steps below by hand.\n";

const saved = { ...safariEnableProbes };
let dir: string;
let appPath: string;
let automationCalls: number;

function release(): string {
  return path.join(dir, "dist", "safari-xcode", ".derived", "Build", "Products", "Release");
}

function listing(rows: Array<{ mark: string; id: string; app: string }>): string {
  const lines = rows.map(
    (row) => `${row.mark}    ${row.id}(1.0)\t3E3BBEFD-8E88-414A-B1B4-4BA28401048E\t2026-11-06 18:15:33 +0000\t${path.join(release(), row.app, "Contents", "PlugIns", `${row.app.replace(/\.app$/, "")} Extension.appex`)}`,
  );

  return `${lines.join("\n")}\n (${rows.length} plug-ins)\n`;
}

function session(log: string, enableExtension = true): void {
  const logPath = path.join(dir, "session.log");
  fs.writeFileSync(logPath, log);
  registerSession({ pid: process.pid, browser: "safari", projectPath: dir, command: "dev", ...(enableExtension ? { enableExtension: true } : {}), logPath });
  writeCompiledUnattachedContract(dir, "safari", { pid: process.pid, extensionId: NEW_ID, extensionName: "Visionario", binary: appPath });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-safari-enable-read-"));
  appPath = path.join(release(), "Visionario.app");
  fs.mkdirSync(appPath, { recursive: true });
  automationCalls = 0;
  safariEnableProbes.platform = () => "darwin";

  safariEnableProbes.automation = () => {
    automationCalls += 1;

    return { ok: true, detail: "" };
  };

  safariEnableProbes.safariRunning = () => true;
  safariEnableProbes.pluginkitList = () => listing([{ mark: " ", id: NEW_ID, app: "Visionario.app" }]);
  safariEnableProbes.extensionsPlist = () => ({ xml: extensionsPlistXml([{ id: NEW_ID, identity: TEAM, enabled: false }]), reason: "" });
  safariEnableProbes.codesign = () => TEAM_SIGNED_CODESIGN;
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

describe("the pluginkit listing of Safari web extensions", () => {
  it("reads the enabled mark, the bundle id and a path with spaces", () => {
    const rows = parsePluginkitList(listing([{ mark: "+", id: OLD_ID, app: "Hands-free.app" }, { mark: " ", id: NEW_ID, app: "Visionario.app" }]));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ enabled: true, bundleId: OLD_ID, version: "1.0" });
    expect(rows[1]).toMatchObject({ enabled: false, bundleId: NEW_ID });
    expect(rows[1]!.path).toBe(path.join(release(), "Visionario.app", "Contents", "PlugIns", "Visionario Extension.appex"));
    expect(parsePluginkitList("  (no matches)\n")).toEqual([]);
  });

  it("matches a Windows-style registration to the built app and names the appex and the earlier app with forward slashes (ledger 549)", () => {
    const winRelease = "C:\\Users\\pat\\visionario\\dist\\safari-xcode\\.derived\\Build\\Products\\Release";
    const row = (mark: string, id: string, app: string) =>
      `${mark}    ${id}(1.0)\t3E3BBEFD-8E88-414A-B1B4-4BA28401048E\t2026-11-06 18:15:33 +0000\t${winRelease}\\${app}\\Contents\\PlugIns\\${app.replace(/\.app$/, "")} Extension.appex`;
    const pluginkit = parsePluginkitList(`${row("+", OLD_ID, "Hands-free.app")}\n${row(" ", NEW_ID, "Visionario.app")}\n (2 plug-ins)\n`);

    const { safari, hint } = readSafariEnable({
      projectPath: "C:\\Users\\pat\\visionario",
      browser: "safari",
      appName: "Visionario",
      appPath: `${winRelease}\\Visionario.app`,
      extensionId: NEW_ID,
      enableExtension: true,
      engineSays: parseSafariEngineSays(""),
      pluginkit,
      rows: null,
      plistReason: "Extensions.plist could not be read: plutil exited 1",
      identity: "ad-hoc",
      personSteps: [],
      automation: null,
      safariRunning: null,
      hostApp: "",
      appExists: true,
    });

    expect(safari.registeredPath).toBe("C:/Users/pat/visionario/dist/safari-xcode/.derived/Build/Products/Release/Visionario.app/Contents/PlugIns/Visionario Extension.appex");
    expect(safari.earlierBundleIds).toEqual([OLD_ID]);
    expect(hint).toContain(`pluginkit lists ${NEW_ID} off at Visionario.app, which is the registration, not Safari's own switch`);
    expect(hint).toContain(`The earlier enable was for ${OLD_ID} (Hands-free.app), a different bundle id; this build registers ${NEW_ID}, so it does not carry over.`);
  });
});

describe("extension_dev / extension_wait on a Safari session the engine could not enable (ledger 450)", () => {
  it("names the missing Accessibility grant for the host app as the one blocker, without the checklist", async () => {
    session(BUILT + SETTINGS_DID_NOT_OPEN);
    safariEnableProbes.automation = () => ({ ok: false, detail: "osascript is not allowed assistive access. (-25211)" });

    const result = await wait();

    expect(result.status).toBe("compiled-not-attached");
    expect(result.value.safari.enabled).toBe(false);
    expect(result.value.safari.bundleId).toBe(NEW_ID);
    expect(result.value.safari.blocker.kind).toBe("accessibility");
    expect(result.value.safari.blocker.detail).toContain("-25211");
    expect(result.value.safari.blocker.fix).toContain("Privacy & Security > Accessibility, add iTerm");
    expect(result.hint).toContain("What blocks it: iTerm has no Accessibility grant");
    expect(result.hint).not.toContain("Allow unsigned extensions");
    expect(result.hint).not.toContain("Websites");
    expect(result.value.safari.manualSteps).toHaveLength(3);
    expect(result.value.safari.manualSteps[1]).toBe("Safari > Settings > Extensions > turn on Visionario");
  }, 10_000);

  it("tells an Automation refusal for System Events apart from Accessibility, and a prompt left unanswered from both", async () => {
    session(BUILT + SETTINGS_DID_NOT_OPEN);
    safariEnableProbes.automation = () => ({ ok: false, detail: "Not authorized to send Apple events to System Events. (-1743)" });

    expect(safariEnableFrame(dir, "safari", true)?.safari.blocker).toMatchObject({ kind: "automation" });
    expect(safariEnableFrame(dir, "safari", true)?.hint).toContain("Automation, turn on System Events under iTerm");

    safariEnableProbes.automation = () => ({ ok: false, detail: "osascript did not answer within 3 s" });

    expect(safariEnableFrame(dir, "safari", true)?.safari.blocker?.kind).toBe("permission-prompt");
  });

  it("answers enabled when Extensions.plist holds the rebuilt app's own identity on, never says not enabled, and skips the osascript probe", async () => {
    session(BUILT + SETTINGS_DID_NOT_OPEN);
    safariEnableProbes.pluginkitList = () => listing([{ mark: "+", id: NEW_ID, app: "Visionario.app" }]);
    safariEnableProbes.extensionsPlist = () => ({ xml: extensionsPlistXml([{ id: NEW_ID, identity: TEAM, enabled: true }]), reason: "" });

    const result = await wait();

    expect(result.value.safari).toMatchObject({ enabled: true, source: "extensions-plist", identity: TEAM, bundleId: NEW_ID, carriesOver: true, blocker: null, appPath });
    expect(result.value.safari.registeredPath).toContain("Visionario.app/Contents/PlugIns");
    expect(result.hint).toContain("Visionario is enabled in Safari");
    expect(result.hint).toContain("the enable holds across the rebuild");
    expect(result.hint).not.toContain("not enabled");
    expect(result.hint).not.toContain("Allow unsigned extensions");
    expect(automationCalls).toBe(0);
  }, 10_000);

  it("says the earlier enable does not carry over when the bundle id changed, and names the Settings window read as what failed", async () => {
    session(BUILT + SETTINGS_DID_NOT_OPEN);
    safariEnableProbes.pluginkitList = () => listing([{ mark: "+", id: OLD_ID, app: "Hands-free.app" }, { mark: " ", id: NEW_ID, app: "Visionario.app" }]);

    const result = await wait();

    expect(result.value.safari).toMatchObject({ enabled: false, bundleId: NEW_ID, earlierBundleIds: [OLD_ID], carriesOver: false });
    expect(result.value.safari.blocker.kind).toBe("settings-window");
    expect(result.value.safari.blocker.detail).toContain("Safari Settings did not open");
    expect(result.value.safari.retry).toMatchObject({ tool: "extension_dev", args: { projectPath: dir, browser: "safari", replace: true, enableExtension: true } });
    expect(result.value.safari.retry.byHand).toContain("npx extension safari enable");
    expect(result.hint).toContain(`The earlier enable was for ${OLD_ID} (Hands-free.app), a different bundle id; this build registers ${NEW_ID}, so it does not carry over.`);
    expect(result.hint).toContain("the engine skips the Xcode build and redoes the enable");
    expect(result.hint).toContain("the one step left is Safari > Settings > Extensions > turn on Visionario");
    expect(result.hint).not.toContain("Allow unsigned extensions");
    expect(result.hint).not.toContain("Read extension_logs");
  }, 10_000);

  it("names a Safari that is not running, an appex pluginkit never registered, and a session that never asked for the enable", () => {
    session(BUILT + SETTINGS_DID_NOT_OPEN);
    safariEnableProbes.safariRunning = () => false;
    expect(safariEnableFrame(dir, "safari", true)?.safari.blocker?.kind).toBe("safari-not-running");

    safariEnableProbes.safariRunning = () => true;
    safariEnableProbes.pluginkitList = () => "  (no matches)\n";
    const unregistered = safariEnableFrame(dir, "safari", true);
    expect(unregistered?.safari.blocker?.kind).toBe("not-registered");
    expect(unregistered?.hint).toContain(`Safari holds ${NEW_ID} (${TEAM}) off`);
    expect(unregistered?.hint).toContain("pluginkit lists no Safari extension under");

    removeSession(dir, "safari");
    removeSessionMarker(dir, "safari");
    session(BUILT, false);
    safariEnableProbes.pluginkitList = () => listing([{ mark: " ", id: NEW_ID, app: "Visionario.app" }]);
    automationCalls = 0;
    const notAsked = safariEnableFrame(dir, "safari", false);
    expect(notAsked?.safari.blocker?.kind).toBe("not-requested");
    expect(notAsked?.hint).toContain("enableExtension: true and replace: true");
    expect(automationCalls).toBe(0);
  });

  it("leaves a non-Safari browser and a non-macOS host with the answer they had", async () => {
    session(BUILT + SETTINGS_DID_NOT_OPEN);

    expect(safariEnableFrame(dir, "chrome", true)).toBeNull();

    safariEnableProbes.platform = () => "linux";

    expect(safariEnableFrame(dir, "safari", true)).toBeNull();

    const result = await wait();

    expect(result.status).toBe("compiled-not-attached");
    expect(result.value.safari).toBeUndefined();
    expect(result.hint).toContain("The extension is not enabled in Safari yet. The engine logged why: Couldn't finish enabling Visionario in Safari: Safari Settings did not open");
  }, 10_000);
});
