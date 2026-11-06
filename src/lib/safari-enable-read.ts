// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { findSessionInfo } from "./process-manager";
import { safariAppBuilding } from "./safari-app-stage";
import { isSafariTarget, notAttachedHint } from "./safari-dev-options";
import { safariEnableProbes, type AutomationProbe, type SafariEnableProbes } from "./safari-enable-probes";
import { parseSafariEngineSays, type SafariEngineSays } from "./safari-enable-log";
import { safariAppPath } from "./safari-signing";
import { readyContractPath } from "./session-paths";

export { safariEnableProbes, SAFARI_WEB_EXTENSION_PROTOCOL, type AutomationProbe, type SafariEnableProbes } from "./safari-enable-probes";

export interface PluginkitEntry {
  enabled: boolean | null;
  bundleId: string;
  version: string | null;
  path: string;
}

export function parsePluginkitList(text: string): PluginkitEntry[] {
  const entries: PluginkitEntry[] = [];

  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([+!-]?)\s*(\S+?)\(([^)]*)\)\t[^\t]*\t[^\t]*\t(.+?)\s*$/);
    if (!match) continue;

    const [, mark, bundleId, version, appexPath] = match;
    entries.push({
      enabled: mark === "+" ? true : mark === "!" ? null : false,
      bundleId: bundleId!,
      version: version?.trim() || null,
      path: appexPath!,
    });
  }

  return entries;
}

export type SafariBlockerKind =
  | "automation"
  | "accessibility"
  | "permission-prompt"
  | "safari-not-running"
  | "app-missing"
  | "not-registered"
  | "settings-window"
  | "switch-off"
  | "not-requested";

export interface SafariBlocker {
  kind: SafariBlockerKind;
  detail: string;
  fix: string;
}

export interface SafariEnableValue {
  enabled: boolean | "unknown";
  bundleId: string | null;
  appPath: string | null;
  registeredPath: string | null;
  earlierBundleIds: string[];
  carriesOver: boolean | null;
  blocker: SafariBlocker | null;
  manualSteps: string[];
  retry: { tool: "extension_dev"; args: Record<string, unknown>; byHand: string; say: string };
}

export interface SafariEnableInput {
  projectPath: string;
  browser: string;
  appName: string;
  appPath: string | null;
  extensionId: string | null;
  enableExtension: boolean;
  engineSays: SafariEngineSays;
  pluginkit: PluginkitEntry[] | null;
  automation: AutomationProbe | null;
  safariRunning: boolean | null;
  hostApp: string;
  appExists: boolean;
}

export function manualSteps(appName: string): string[] {
  return [
    "Safari > Settings > Developer > Allow unsigned extensions (an ad-hoc signed app only; Safari turns it off at every quit)",
    `Safari > Settings > Extensions > turn on ${appName}`,
    `Safari > Settings > Websites > ${appName} > For other websites > Allow`,
  ];
}

function grantBlocker(probe: AutomationProbe, host: string): SafariBlocker {
  const pane = "System Settings > Privacy & Security";

  if (/-1743\b|not authorized to send apple events/i.test(probe.detail)) {
    return {
      kind: "automation",
      detail: `${host} may not control System Events: ${probe.detail}`,
      fix: `Open ${pane} > Automation, turn on System Events under ${host}, then call extension_dev again with the same arguments.`,
    };
  }

  if (/-25211\b|-1719\b|assistive access/i.test(probe.detail)) {
    return {
      kind: "accessibility",
      detail: `${host} has no Accessibility grant: ${probe.detail}`,
      fix: `Open ${pane} > Accessibility, add ${host} and turn it on, then call extension_dev again with the same arguments.`,
    };
  }

  if (/did not answer within/.test(probe.detail)) {
    return {
      kind: "permission-prompt",
      detail: `${probe.detail}, which is how a macOS permission prompt waiting for an answer reads`,
      fix: `Answer the macOS prompt for ${host} (or grant it under ${pane} > Automation and Accessibility), then call extension_dev again with the same arguments.`,
    };
  }

  return {
    kind: "accessibility",
    detail: `System Events could not be read from ${host}: ${probe.detail}`,
    fix: `Grant ${host} Accessibility and Automation for System Events under ${pane}, then call extension_dev again with the same arguments.`,
  };
}

function retryFor(input: SafariEnableInput, say: string): SafariEnableValue["retry"] {
  return {
    tool: "extension_dev",
    args: { projectPath: input.projectPath, browser: input.browser, replace: true, enableExtension: true },
    byHand: `npx extension safari enable ${JSON.stringify(input.projectPath)}`,
    say,
  };
}

const RETRY_SAY =
  "Call extension_dev again with the same arguments: the build is current, so the engine skips the Xcode build and redoes the enable; `npx extension safari enable <projectPath>` in the project redoes only the enable on the running session.";

function blockerFor(input: SafariEnableInput, current: PluginkitEntry | null): SafariBlocker {
  const { appName } = input;

  if (!input.enableExtension) {
    return {
      kind: "not-requested",
      detail: "this session was started without enableExtension: true, and the engine switches the extension on only when asked",
      fix: `Call extension_dev again with enableExtension: true and replace: true, or turn it on under Safari > Settings > Extensions > ${appName}.`,
    };
  }

  if (input.automation && !input.automation.ok) return grantBlocker(input.automation, input.hostApp);

  if (input.safariRunning === false) {
    return {
      kind: "safari-not-running",
      detail: "Safari is not running, so there is no Settings window to drive",
      fix: `${RETRY_SAY} The engine starts Safari first.`,
    };
  }

  if (input.appPath && !input.appExists) {
    return {
      kind: "app-missing",
      detail: `no Safari app at ${input.appPath}`,
      fix: "Call extension_dev again with the same arguments so the engine builds the app; extension_logs shows the xcodebuild lines if the build failed.",
    };
  }

  if (!current) {
    return {
      kind: "not-registered",
      detail: `pluginkit lists no Safari extension under ${input.appPath ?? "the built app"}${input.extensionId ? ` (expected ${input.extensionId})` : ""}, so Safari Settings has no row to switch on`,
      fix: `${RETRY_SAY} The engine registers the appex with pluginkit -a before the switch.`,
    };
  }

  const engineLine = input.engineSays.lines.find((line) => /Couldn't finish enabling/.test(line)) ?? input.engineSays.lines[0] ?? null;
  const grants = "The grants are in place (System Events answered), Safari is running and the extension is registered";

  if (engineLine && /Safari Settings did not (open|switch)/.test(engineLine)) {
    return {
      kind: "settings-window",
      detail: `${grants}; what failed is the engine's read of the Safari Settings window: ${engineLine}`,
      fix: `${RETRY_SAY} If it repeats, the one step left is Safari > Settings > Extensions > turn on ${appName}.`,
    };
  }

  return {
    kind: "switch-off",
    detail: engineLine ? `${grants}; the engine logged: ${engineLine}` : `pluginkit lists ${current.bundleId} off, and the engine logged no enable line`,
    fix: `${RETRY_SAY} If it repeats, the one step left is Safari > Settings > Extensions > turn on ${appName}.`,
  };
}

function appOf(appexPath: string): string {
  const app = appexPath.match(/\/([^/]+\.app)\//);

  return app ? app[1]! : path.basename(appexPath);
}

export function readSafariEnable(input: SafariEnableInput): { safari: SafariEnableValue; hint: string } {
  const entries = input.pluginkit ?? [];
  const under = (entry: PluginkitEntry, root: string | null): boolean => root !== null && entry.path.startsWith(`${root.replace(/[\\/]+$/, "")}/`);
  const current =
    entries.find((entry) => under(entry, input.appPath)) ??
    entries.find((entry) => input.extensionId !== null && entry.bundleId === input.extensionId) ??
    null;
  const releaseDir = input.appPath ? path.dirname(input.appPath) : null;
  const earlier = entries.filter((entry) => entry !== current && under(entry, releaseDir) && entry.bundleId !== current?.bundleId);
  const bundleId = current?.bundleId ?? input.extensionId;
  const enabled: boolean | "unknown" = input.pluginkit === null ? "unknown" : current?.enabled === true;
  const steps = manualSteps(input.appName);
  const earlierSentence =
    earlier.length > 0
      ? ` The earlier enable was for ${earlier.map((entry) => `${entry.bundleId} (${appOf(entry.path)})`).join(", ")}, a different bundle id; this build registers ${bundleId ?? "another one"}, so it does not carry over.`
      : "";

  if (enabled === true && current) {
    const say =
      `${input.appName} is enabled in Safari: pluginkit lists ${current.bundleId} on at ${appOf(current.path)}, the app this build produced, so the enable holds across the rebuild and nothing in Safari Settings is left to do. ` +
      "The background has not connected yet: call extension_wait again; if it stays unattached, open a page the extension matches with extension_open url.";

    return {
      safari: {
        enabled: true,
        bundleId: current.bundleId,
        appPath: input.appPath,
        registeredPath: current.path,
        earlierBundleIds: earlier.map((entry) => entry.bundleId),
        carriesOver: true,
        blocker: null,
        manualSteps: steps,
        retry: retryFor(input, "Nothing to redo: the extension is on."),
      },
      hint: say,
    };
  }

  if (enabled === "unknown") {
    return {
      safari: {
        enabled: "unknown",
        bundleId,
        appPath: input.appPath,
        registeredPath: null,
        earlierBundleIds: [],
        carriesOver: null,
        blocker: null,
        manualSteps: steps,
        retry: retryFor(input, RETRY_SAY),
      },
      hint: notAttachedHint(input.browser, input.enableExtension, input.engineSays),
    };
  }

  const blocker = blockerFor(input, current);
  const listed = current ? `pluginkit lists ${current.bundleId} off` : "pluginkit lists no extension for this build";
  const say = `${input.appName} is not enabled in Safari (${listed}). What blocks it: ${blocker.detail}. ${blocker.fix}${earlierSentence}`;

  return {
    safari: {
      enabled: false,
      bundleId,
      appPath: input.appPath,
      registeredPath: current?.path ?? null,
      earlierBundleIds: earlier.map((entry) => entry.bundleId),
      carriesOver: earlier.length > 0 ? false : null,
      blocker,
      manualSteps: steps,
      retry: retryFor(input, blocker.fix),
    },
    hint: say,
  };
}

function readContract(projectPath: string, browser: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readLog(logPath: string | undefined): string {
  if (!logPath) return "";

  try {
    return fs.readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

export function safariEnableFrame(
  projectPath: string,
  browser: string,
  enableExtension: boolean,
  probes: SafariEnableProbes = safariEnableProbes,
): { safari: SafariEnableValue; hint: string } | null {
  if (!isSafariTarget(browser) || probes.platform() !== "darwin") return null;
  if (safariAppBuilding(projectPath, browser)) return null;

  const session = findSessionInfo(projectPath, browser);
  const contract = readContract(projectPath, browser);
  const log = readLog(session?.logPath);
  const appName =
    session?.appName ?? (typeof contract.extensionName === "string" && contract.extensionName.trim() ? contract.extensionName : path.basename(projectPath));
  const appPath =
    typeof contract.binary === "string" && contract.binary.endsWith(".app")
      ? contract.binary
      : safariAppPath(projectPath, browser, { appName: session?.appName, sessionOutput: log });
  const listing = probes.pluginkitList();
  const pluginkit = listing === null ? null : parsePluginkitList(listing);
  const underApp = pluginkit?.find((entry) => entry.path.startsWith(`${appPath}/`));
  const settled = underApp?.enabled === true || pluginkit === null;

  return readSafariEnable({
    projectPath,
    browser,
    appName,
    appPath,
    extensionId: typeof contract.extensionId === "string" ? contract.extensionId : null,
    enableExtension,
    engineSays: parseSafariEngineSays(log),
    pluginkit,
    automation: settled || !enableExtension ? null : probes.automation(),
    safariRunning: settled || !enableExtension ? null : probes.safariRunning(),
    hostApp: settled ? "" : probes.hostApp(),
    appExists: fs.existsSync(appPath),
  });
}
