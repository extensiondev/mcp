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
import {
  PERSISTED_PROFILE_DIR_NAME,
  browserProfileRootDir,
} from "./session-paths";

export const SYSTEM_PROFILE_ARG = "false";

function holdsState(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export function profileCarriesTabsOver(
  projectPath: string,
  browser: string,
  profileArg?: string,
): boolean {
  const raw = typeof profileArg === "string" ? profileArg.trim() : "";
  if (raw === SYSTEM_PROFILE_ARG) return true;
  if (raw) return holdsState(path.resolve(projectPath, raw));

  return holdsState(
    path.join(
      browserProfileRootDir(projectPath, browser),
      PERSISTED_PROFILE_DIR_NAME,
    ),
  );
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
