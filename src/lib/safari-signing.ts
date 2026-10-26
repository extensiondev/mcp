// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { describeCodeSignature } from "./codesign";
import { findSessionInfo, sessionSidecarPath } from "./process-manager";
import { isSafariTarget } from "./safari-dev-options";
import { engineProjectRoot, readyContractPath } from "./session-paths";

export type SigningIdentity = `team:${string}` | "ad-hoc" | "unknown";

export interface SafariSigning {
  requested: string | null;
  identity: SigningIdentity;
  appPath?: string;
}

export interface SafariSigningFrame {
  signing: SafariSigning;
  warnings: string[];
  hints: string[];
}

interface SigningRecord {
  identity: SigningIdentity;
  previousIdentity?: SigningIdentity;
  sessionPid: number | null;
}

const SIDECAR = "safari-signing";

export function parseCodesignIdentity(text: string | null): SigningIdentity {
  if (!text) return "unknown";

  const team = text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (team && team !== "not set") return `team:${team}`;

  if (/^Signature=adhoc$/m.test(text) || /flags=0x[0-9a-f]+\(.*adhoc.*\)/i.test(text)) return "ad-hoc";

  return "unknown";
}

export function sanitizeSafariAppName(value: string): string {
  const cleaned = String(value || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length > 0 ? cleaned : "Extension";
}

function manifestName(projectPath: string, browser: string): string | null {
  const candidates: string[] = [];

  try {
    const contract = JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as {
      manifestPath?: unknown;
    };
    if (typeof contract.manifestPath === "string") candidates.push(contract.manifestPath);
  } catch {
  }

  const root = engineProjectRoot(projectPath);
  candidates.push(path.join(root, "src", "manifest.json"), path.join(root, "manifest.json"));

  for (const file of candidates) {
    try {
      const name = (JSON.parse(fs.readFileSync(file, "utf8")) as { name?: unknown }).name;
      if (typeof name === "string" && name.trim()) return name;
    } catch {
    }
  }

  return null;
}

function distPath(projectPath: string, browser: string): string {
  try {
    const contract = JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as {
      distPath?: unknown;
    };
    if (typeof contract.distPath === "string" && contract.distPath) return contract.distPath;
  } catch {
  }

  return path.join(engineProjectRoot(projectPath), "dist", browser);
}

export function appPathFromSessionOutput(output: string): string | null {
  const derived = output.match(/-derivedDataPath\s+(\S+)/)?.[1];
  const project = output.match(/-project\s+(\S+?)\.xcodeproj\b/)?.[1];
  if (!derived || !project) return null;

  const layout = derived.includes("\\") ? path.win32 : path.posix;

  return layout.join(derived, "Build", "Products", "Release", `${layout.basename(project)}.app`);
}

export function safariAppPath(
  projectPath: string,
  browser: string,
  options: { appName?: string; sessionOutput?: string },
): string {
  const fromLog = options.sessionOutput ? appPathFromSessionOutput(options.sessionOutput) : null;
  if (fromLog) return fromLog;

  const appName = sanitizeSafariAppName(options.appName || manifestName(projectPath, browser) || "Extension");

  return path.join(`${distPath(projectPath, browser).replace(/[\\/]+$/, "")}-xcode`, ".derived", "Build", "Products", "Release", `${appName}.app`);
}

function readRecord(file: string): SigningRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SigningRecord>;

    return typeof parsed.identity === "string"
      ? { identity: parsed.identity, previousIdentity: parsed.previousIdentity, sessionPid: parsed.sessionPid ?? null }
      : null;
  } catch {
    return null;
  }
}

export function recordSigningIdentity(
  projectPath: string,
  browser: string,
  identity: SigningIdentity,
  sessionPid: number | null,
): SigningIdentity | null {
  if (identity === "unknown") return null;

  const file = sessionSidecarPath(projectPath, browser, SIDECAR);
  const prior = readRecord(file);
  const sameSession = prior !== null && prior.sessionPid !== null && prior.sessionPid === sessionPid;
  const next: SigningRecord = sameSession
    ? { ...prior, identity }
    : { identity, ...(prior ? { previousIdentity: prior.identity } : {}), sessionPid };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next));
  } catch {
  }

  const previous = next.previousIdentity;

  return previous && previous !== "unknown" && previous !== identity ? previous : null;
}

function readSessionOutput(logPath: string | undefined): string {
  if (!logPath) return "";

  try {
    return fs.readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

export function adHocDespiteTeamWarning(requested: string, sessionOutput: string): string {
  const printed = new RegExp(`No Account for Team "?${requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?`).test(sessionOutput);
  const cause = printed
    ? `Xcode has no account for team ${requested}: xcodebuild printed "No Account for Team" in this session's log.`
    : `the likely cause is that Xcode has no account for team ${requested} (xcodebuild prints "No Account for Team" when that is so; extension_logs does not carry it, the session log does).`;

  return (
    `developmentTeam ${requested} was requested, but the built app is ad-hoc signed (codesign reads Signature=adhoc): ${cause} ` +
    "Fix: sign in to Xcode with that team's Apple ID (Xcode > Settings > Accounts), set developmentTeam to a team Xcode already knows, or drop developmentTeam for an ad-hoc build."
  );
}

export function otherTeamWarning(requested: string, identity: SigningIdentity): string {
  return `developmentTeam ${requested} was requested, but the built app is signed by ${identity.replace(/^team:/, "team ")} (codesign reads TeamIdentifier). Xcode signed with the team it knows; pass that team as developmentTeam or sign in to Xcode with the requested team's Apple ID.`;
}

export function identityChangedHint(previous: SigningIdentity, identity: SigningIdentity): string {
  return (
    `The app's signing identity changed since the previous run (${previous} before, ${identity} now). Safari treats the newly signed app as a new extension, so it must be enabled again: ` +
    "enableExtension: true does that without a Settings trip (call extension_dev again with replace: true and enableExtension: true), or turn it on in Safari > Settings > Extensions."
  );
}

export async function safariSigningFrame(
  projectPath: string,
  browser: string,
  options: { requested?: string; appName?: string; logPath?: string; sessionPid?: number | null } = {},
): Promise<SafariSigningFrame | null> {
  if (!isSafariTarget(browser)) return null;

  const session = findSessionInfo(projectPath, browser);
  const requested = (options.requested ?? session?.developmentTeam ?? "").trim() || null;
  const appName = options.appName ?? session?.appName;
  const sessionOutput = readSessionOutput(options.logPath ?? session?.logPath);
  const sessionPid = options.sessionPid ?? session?.pid ?? null;
  const appPath = safariAppPath(projectPath, browser, { appName, sessionOutput });
  const description = fs.existsSync(appPath) ? await describeCodeSignature(appPath) : null;
  const identity = parseCodesignIdentity(description);
  const warnings: string[] = [];
  const hints: string[] = [];

  if (identity === "unknown") {
    return { signing: { requested, identity, appPath }, warnings, hints };
  }

  if (requested && identity === "ad-hoc") warnings.push(adHocDespiteTeamWarning(requested, sessionOutput));
  if (requested && identity !== "ad-hoc" && identity !== `team:${requested}`) warnings.push(otherTeamWarning(requested, identity));

  const previous = recordSigningIdentity(projectPath, browser, identity, sessionPid);
  if (previous) hints.push(identityChangedHint(previous, identity));

  return { signing: { requested, identity, appPath }, warnings, hints };
}
