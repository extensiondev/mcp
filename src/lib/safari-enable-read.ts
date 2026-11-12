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
import { isSafariTarget } from "./safari-dev-options";
import {
  blockerFor,
  manualSteps,
  otherCopyBlocker,
  retryFor,
  RETRY_SAY,
  unsignedRowBlocker,
  type SafariBlocker,
  type SafariBlockerInput,
  type SafariRetry,
} from "./safari-enable-blockers";
import { safariEnableProbes, type SafariEnableProbes } from "./safari-enable-probes";
import { parseSafariEngineSays } from "./safari-enable-log";
import { describeIdentity, parseSafariExtensionsPlist, plistIdentityOf, UNSIGNED_IDENTITY, type SafariExtensionRow } from "./safari-extensions-plist";
import { safariPersonSteps, type SafariPersonStep } from "./safari-person-steps";
import { parseCodesignIdentity, safariAppPath, type SigningIdentity } from "./safari-signing";
import { posixPath, readyContractPath } from "./session-paths";

export { safariEnableProbes, SAFARI_WEB_EXTENSION_PROTOCOL, type AutomationProbe, type SafariEnableProbes } from "./safari-enable-probes";
export { manualSteps, type SafariBlocker, type SafariBlockerKind } from "./safari-enable-blockers";

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

export interface SafariEnableValue {
  enabled: boolean | "unknown";
  source: "extensions-plist" | "pluginkit";
  bundleId: string | null;
  identity: string | null;
  appPath: string | null;
  registeredPath: string | null;
  rows: SafariExtensionRow[];
  earlierBundleIds: string[];
  carriesOver: boolean | null;
  blocker: SafariBlocker | null;
  unknownReason: string | null;
  personSteps: SafariPersonStep[];
  manualSteps: string[];
  retry: SafariRetry;
}

export interface SafariEnableInput extends SafariBlockerInput {
  pluginkit: PluginkitEntry[] | null;
  rows: SafariExtensionRow[] | null;
  plistReason: string | null;
  identity: SigningIdentity;
  personSteps: SafariPersonStep[];
}

function appOf(appexPath: string): string {
  const app = posixPath(appexPath).match(/\/([^/]+\.app)\//);

  return app ? app[1]! : path.basename(appexPath);
}

function registeredUnder(entry: PluginkitEntry, root: string | null): boolean {
  return root !== null && posixPath(entry.path).startsWith(`${posixPath(root).replace(/\/+$/, "")}/`);
}

const NOT_CONNECTED = "The background has not connected yet: call extension_wait again; if it stays unattached, open a page the extension matches with extension_open url.";

export function readSafariEnable(input: SafariEnableInput): { safari: SafariEnableValue; hint: string } {
  const entries = input.pluginkit ?? [];
  const current =
    entries.find((entry) => registeredUnder(entry, input.appPath)) ??
    entries.find((entry) => input.extensionId !== null && entry.bundleId === input.extensionId) ??
    null;
  const releaseDir = input.appPath ? path.posix.dirname(posixPath(input.appPath)) : null;
  const earlier = entries.filter((entry) => entry !== current && registeredUnder(entry, releaseDir) && entry.bundleId !== current?.bundleId);
  const bundleId = current?.bundleId ?? input.extensionId;
  const fresh = plistIdentityOf(input.identity);
  const rows = bundleId !== null && input.rows ? input.rows.filter((row) => row.bundleId === bundleId) : [];
  const personSay = input.personSteps.length > 0 ? ` ${input.personSteps.map((step) => step.step).join(" ")}` : "";
  const earlierSentence =
    earlier.length > 0
      ? ` The earlier enable was for ${earlier.map((entry) => `${entry.bundleId} (${appOf(entry.path)})`).join(", ")}, a different bundle id; this build registers ${bundleId ?? "another one"}, so it does not carry over.`
      : "";
  const base = {
    bundleId,
    identity: fresh,
    appPath: input.appPath,
    registeredPath: current ? posixPath(current.path) : null,
    rows,
    earlierBundleIds: earlier.map((entry) => entry.bundleId),
    personSteps: input.personSteps,
    manualSteps: manualSteps(input.appName),
  };

  if (input.rows === null) {
    const reason = input.plistReason || "Safari's Extensions.plist could not be read";
    const registered = current
      ? `pluginkit lists ${current.bundleId} ${current.enabled === true ? "on" : current.enabled === null ? "in an unknown state" : "off"} at ${appOf(current.path)}, which is the registration, not Safari's own switch`
      : "pluginkit lists no extension for this build";

    return {
      safari: { ...base, enabled: "unknown", source: "pluginkit", carriesOver: null, blocker: null, unknownReason: reason, retry: retryFor(input, RETRY_SAY) },
      hint: `Whether ${input.appName} is enabled in Safari is unknown: ${reason}; ${registered}. ${RETRY_SAY}${earlierSentence}${personSay}`,
    };
  }

  const freshRow = fresh !== null ? rows.find((row) => row.identity === fresh) : rows.length === 1 ? rows[0] : undefined;

  if (freshRow?.enabled) {
    const say =
      `${input.appName} is enabled in Safari: Extensions.plist holds ${bundleId} (${freshRow.identity}) on, the ${describeIdentity(freshRow.identity)} app this build produced, so the enable holds across the rebuild and nothing in Safari Settings is left to do. ` +
      `${NOT_CONNECTED}${personSay}`;

    return {
      safari: { ...base, enabled: true, source: "extensions-plist", identity: freshRow.identity, carriesOver: true, blocker: null, unknownReason: null, retry: retryFor(input, "Nothing to redo: the extension is on.") },
      hint: say,
    };
  }

  if (fresh === null && rows.length > 1) {
    const reason = `codesign could not say which signing identity the app at ${input.appPath ?? "the build path"} carries, and Safari holds ${rows.length} rows for ${bundleId} (${rows.map((row) => `${row.identity} ${row.enabled ? "on" : "off"}`).join(", ")})`;

    return {
      safari: { ...base, enabled: "unknown", source: "extensions-plist", carriesOver: null, blocker: null, unknownReason: reason, retry: retryFor(input, RETRY_SAY) },
      hint: `Whether ${input.appName} is enabled in Safari is unknown: ${reason}. ${RETRY_SAY}${earlierSentence}${personSay}`,
    };
  }

  const team = rows.map((row) => row.identity).find((identity) => identity !== UNSIGNED_IDENTITY) ?? (fresh !== null && fresh !== UNSIGNED_IDENTITY ? fresh : null);
  const live = rows.find((row) => row.enabled && row !== freshRow);
  const freshIdentity = fresh ?? freshRow?.identity ?? null;
  const unsignedOff = freshIdentity === UNSIGNED_IDENTITY && current !== null && input.appExists;
  const blocker =
    live && freshIdentity !== null
      ? otherCopyBlocker(input, freshIdentity, live, team)
      : unsignedOff
        ? unsignedRowBlocker(input, bundleId ?? input.appName, team, freshRow !== undefined)
        : blockerFor(input, current);
  const listed = freshRow
    ? `Safari holds ${bundleId} (${freshRow.identity}) off`
    : rows.length > 0
      ? `Safari holds no row for ${bundleId} (${freshIdentity ?? "this build's identity"}) yet, only ${rows.map((row) => `(${row.identity}) ${row.enabled ? "on" : "off"}`).join(" and ")}`
      : `Safari's Extensions.plist holds no row for ${bundleId ?? "this build"} yet`;
  const withTeam = blocker.kind === "unsigned-row" || (blocker.kind === "other-copy" && freshIdentity === UNSIGNED_IDENTITY) ? (team ?? undefined) : undefined;

  return {
    safari: { ...base, enabled: false, source: "extensions-plist", carriesOver: earlier.length > 0 ? false : null, blocker, unknownReason: null, retry: retryFor(input, blocker.fix, withTeam) },
    hint: `${input.appName} is not enabled in Safari (${listed}). What blocks it: ${blocker.detail}. ${blocker.fix}${earlierSentence}${personSay}`,
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

export interface SafariEnableFrameOptions {
  probes?: SafariEnableProbes;
  identity?: SigningIdentity;
}

export function safariEnableFrame(
  projectPath: string,
  browser: string,
  enableExtension: boolean,
  options: SafariEnableFrameOptions = {},
): { safari: SafariEnableValue; hint: string } | null {
  const probes = options.probes ?? safariEnableProbes;
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
  const appExists = fs.existsSync(appPath);
  const extensionId = typeof contract.extensionId === "string" ? contract.extensionId : null;
  const listing = probes.pluginkitList();
  const pluginkit = listing === null ? null : parsePluginkitList(listing);
  const plist = probes.extensionsPlist();
  const rows = plist.xml === null ? null : parseSafariExtensionsPlist(plist.xml);
  const identity = options.identity && options.identity !== "unknown" ? options.identity : parseCodesignIdentity(appExists ? probes.codesign(appPath) : null);
  const bundleId = pluginkit?.find((entry) => registeredUnder(entry, appPath))?.bundleId ?? extensionId;
  const fresh = plistIdentityOf(identity);
  const own = rows?.filter((row) => row.bundleId === bundleId) ?? [];
  const freshRow = fresh !== null ? own.find((row) => row.identity === fresh) : own.length === 1 ? own[0] : undefined;
  const settled = rows === null || freshRow?.enabled === true;

  return readSafariEnable({
    projectPath,
    browser,
    appName,
    appPath,
    extensionId,
    enableExtension,
    engineSays: parseSafariEngineSays(log),
    pluginkit,
    rows,
    plistReason: plist.xml === null ? plist.reason : null,
    identity,
    personSteps: safariPersonSteps(projectPath, browser, typeof contract.distPath === "string" ? contract.distPath : null),
    automation: settled || !enableExtension ? null : probes.automation(),
    safariRunning: settled || !enableExtension ? null : probes.safariRunning(),
    hostApp: settled ? "" : probes.hostApp(),
    appExists,
  });
}
