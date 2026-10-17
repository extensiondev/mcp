// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { findSessionInfo } from "./process-manager";
import {
  EXTENSION_CONFIG_FILENAMES,
  PERSISTED_PROFILE_DIR_NAME,
  browserProfileRootDir,
  engineProjectRoot,
  readyContractPath,
} from "./session-paths";

export const SYSTEM_PROFILE_ARG = "false";

const CONFIG_PROFILE_MARK = "__mcp_config_profile__";
const CONFIG_PROFILE_SCRIPT = `import(process.argv[1]).then((m) => {
  const c = m && "default" in m ? m.default : m;
  const b = c && c.browser && c.browser[process.argv[2]];
  const p = b && typeof b === "object" ? b.profile : undefined;
  console.log("${CONFIG_PROFILE_MARK}" + JSON.stringify(p === undefined ? null : p));
}, () => console.log("${CONFIG_PROFILE_MARK}null"));`;

export interface ProfileCarryover {
  reused: boolean;
  profilePath: string | null;
  held: Map<string, boolean>;
}

function holdsState(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function heldBefore(dir: string, launchedAt: number): boolean {
  let entries: string[];

  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }

  return entries.some((name) => {
    try {
      const stat = fs.statSync(path.join(dir, name));
      const born = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;

      return born < launchedAt;
    } catch {
      return false;
    }
  });
}

function configSetProfile(root: string, browser: string): string | boolean | null {
  const file = EXTENSION_CONFIG_FILENAMES.map((name) => path.join(root, name)).find((candidate) =>
    fs.existsSync(candidate),
  );
  if (!file) return null;

  let out: string;

  try {
    out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", CONFIG_PROFILE_SCRIPT, pathToFileURL(file).href, browser],
      { cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return null;
  }

  const line = out.split("\n").reverse().find((l) => l.startsWith(CONFIG_PROFILE_MARK));
  if (!line) return null;

  let value: unknown;

  try {
    value = JSON.parse(line.slice(CONFIG_PROFILE_MARK.length));
  } catch {
    return null;
  }

  if (typeof value === "boolean") return value;

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function previousProfilePath(projectPath: string, browser: string): string | null {
  try {
    const contract = JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as {
      profilePath?: unknown;
    };

    return typeof contract.profilePath === "string" && contract.profilePath.trim()
      ? contract.profilePath
      : null;
  } catch {
    return null;
  }
}

export function profileCarryoverBeforeLaunch(
  projectPath: string,
  browser: string,
  profileArg?: string,
): ProfileCarryover {
  const root = engineProjectRoot(projectPath);
  const held = new Map<string, boolean>();

  const snap = (dir: string): boolean => {
    const key = path.resolve(dir);
    if (!held.has(key)) held.set(key, holdsState(key));

    return held.get(key) === true;
  };

  const at = (dir: string): ProfileCarryover => ({
    reused: snap(dir),
    profilePath: path.resolve(dir),
    held,
  });
  const system: ProfileCarryover = { reused: true, profilePath: null, held };

  const managed = path.join(browserProfileRootDir(projectPath, browser), PERSISTED_PROFILE_DIR_NAME);
  snap(managed);
  const previous = previousProfilePath(projectPath, browser);
  if (previous) snap(previous);

  const raw = typeof profileArg === "string" ? profileArg.trim() : "";
  if (raw === SYSTEM_PROFILE_ARG) return system;
  if (raw) return at(path.resolve(projectPath, raw));

  const configured = configSetProfile(root, browser);
  if (configured === false || configured === SYSTEM_PROFILE_ARG) return system;
  if (typeof configured === "string") return at(path.resolve(root, configured));

  return at(managed);
}

export function profileReusedAt(
  carryover: ProfileCarryover,
  profilePath: unknown,
  launchedAt: number,
): boolean {
  if (typeof profilePath !== "string" || !profilePath.trim()) return carryover.reused;

  const key = path.resolve(profilePath);
  const snapped = carryover.held.get(key);

  return snapped ?? heldBefore(key, launchedAt);
}

export function reusedProfileNote(profilePath?: unknown): string {
  const where = typeof profilePath === "string" && profilePath.trim() ? ` (${profilePath})` : "";

  return `Not a fresh start: this session runs on a browser profile that already held state from an earlier run${where}. The extension's chrome.storage, the permissions it was granted and any restored tabs all come from that earlier run, so read storage with extension_storage before acting on a toggle, a setting or a first-run assumption (clicking a toggle that is already on turns it off). extension_inspect with no target ranks whatever is open and can land on a restored tab; it flags this session as profileReused for that reason. Pass url, or open the surface you mean with extension_open, before reading anything.`;
}

export function sessionProfileReused(
  projectPath: string,
  browser: string,
): boolean {
  return findSessionInfo(projectPath, browser)?.profileReused === true;
}

export function restoredTabWarning(url: string): string {
  return `No target was given and this session runs on a browser profile that already held a previous session's state, so ${url} may be a tab restored from that previous session rather than anything this run opened. Nothing here proves the page belongs to the extension you just started: pass url, or open a surface with extension_open, and inspect again.`;
}
