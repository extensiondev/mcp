// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describeIdentity, UNSIGNED_IDENTITY, type SafariExtensionRow } from "./safari-extensions-plist";

import type { AutomationProbe } from "./safari-enable-probes";
import type { SafariEngineSays } from "./safari-enable-log";

export type SafariBlockerKind =
  | "automation"
  | "accessibility"
  | "permission-prompt"
  | "safari-not-running"
  | "app-missing"
  | "not-registered"
  | "settings-window"
  | "switch-off"
  | "other-copy"
  | "unsigned-row"
  | "not-requested";

export interface SafariBlocker {
  kind: SafariBlockerKind;
  detail: string;
  fix: string;
}

export interface SafariBlockerInput {
  projectPath: string;
  browser: string;
  appName: string;
  appPath: string | null;
  extensionId: string | null;
  enableExtension: boolean;
  engineSays: SafariEngineSays;
  automation: AutomationProbe | null;
  safariRunning: boolean | null;
  hostApp: string;
  appExists: boolean;
}

export interface SafariRetry {
  tool: "extension_dev";
  args: Record<string, unknown>;
  byHand: string;
  say: string;
}

export const RETRY_SAY =
  "Call extension_dev again with the same arguments: the build is current, so the engine skips the Xcode build and redoes the enable; `npx extension safari enable <projectPath>` in the project redoes only the enable on the running session.";

export function manualSteps(appName: string): string[] {
  return [
    "Safari > Settings > Developer > Allow unsigned extensions (an ad-hoc signed app only; Safari turns it off at every quit)",
    `Safari > Settings > Extensions > turn on ${appName}`,
    `Safari > Settings > Websites > ${appName} > For other websites > Allow`,
  ];
}

export function retryFor(input: SafariBlockerInput, say: string, developmentTeam?: string): SafariRetry {
  return {
    tool: "extension_dev",
    args: {
      projectPath: input.projectPath,
      browser: input.browser,
      replace: true,
      enableExtension: true,
      ...(developmentTeam ? { developmentTeam } : {}),
    },
    byHand: `npx extension safari enable ${JSON.stringify(input.projectPath)}`,
    say,
  };
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

export function blockerFor(input: SafariBlockerInput, registered: { bundleId: string } | null): SafariBlocker {
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

  if (!registered) {
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
    detail: engineLine ? `${grants}; the engine logged: ${engineLine}` : `pluginkit lists ${registered.bundleId} off, and the engine logged no enable line`,
    fix: `${RETRY_SAY} If it repeats, the one step left is Safari > Settings > Extensions > turn on ${appName}.`,
  };
}

const UNSIGNED_NO_AUTOMATION =
  "an unsigned row does not switch on by automation (an AX click, AXPress or a CGEvent click leaves it off even with Allow unsigned extensions on), while a team-signed row toggles";

function teamRoute(team: string | null): string {
  const value = team ?? "<team>";

  return `call extension_dev again with developmentTeam: ${JSON.stringify(value)} (xcodebuild DEVELOPMENT_TEAM=${value}) so the enabled row and the fresh files are the same app`;
}

export function otherCopyBlocker(input: SafariBlockerInput, fresh: string, live: SafariExtensionRow, team: string | null): SafariBlocker {
  const { appName } = input;
  const detail =
    `Safari runs ${live.bundleId} (${live.identity}), the copy ${describeIdentity(live.identity)}, not the ${describeIdentity(fresh)} app this build produced at ${input.appPath ?? "the build path"}; ` +
    "that other copy loads whatever files its own build left, which is how a stale copy reads as \"Safari can't find the file\" (NSURLError -1100)";

  if (fresh === UNSIGNED_IDENTITY) {
    return {
      kind: "other-copy",
      detail,
      fix: `Rebuild team-signed: ${teamRoute(team)}; or by hand in Safari > Settings > Extensions turn off ${appName} (${live.identity}) and turn on ${appName} (${UNSIGNED_IDENTITY}) after Safari > Settings > Developer > Allow unsigned extensions, because ${UNSIGNED_NO_AUTOMATION}.`,
    };
  }

  return {
    kind: "other-copy",
    detail,
    fix: `${RETRY_SAY} The engine switches the team-signed row ${appName} (${fresh}) on; or by hand in Safari > Settings > Extensions turn off ${appName} (${live.identity}) and turn on ${appName} (${fresh}).`,
  };
}

export function unsignedRowBlocker(input: SafariBlockerInput, bundleId: string, team: string | null, hasRow: boolean): SafariBlocker {
  const holds = hasRow ? `Safari holds ${bundleId} (${UNSIGNED_IDENTITY}) off` : `Safari lists no row for ${bundleId} (${UNSIGNED_IDENTITY}) yet`;

  return {
    kind: "unsigned-row",
    detail: `${holds}, and ${UNSIGNED_NO_AUTOMATION}`,
    fix: `Rebuild team-signed: ${teamRoute(team)}, then the engine's enable switches the signed row on; or by hand: Safari > Settings > Developer > Allow unsigned extensions, then Safari > Settings > Extensions > turn on ${input.appName}.`,
  };
}
