// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { readBuiltManifest } from "./project-manifest";
import { readyContractPath } from "./session-paths";

const UUIDS_PREF = /user_pref\("extensions\.webextensions\.uuids",\s*"((?:[^"\\]|\\.)*)"\)/;

export function geckoAddonId(projectPath: string, browser: string): string | null {
  const read = readBuiltManifest(projectPath, browser);
  const manifest = read?.manifest as Record<string, any> | undefined;
  const settings =
    manifest?.browser_specific_settings ??
    manifest?.["firefox:browser_specific_settings"] ??
    manifest?.["gecko:browser_specific_settings"] ??
    manifest?.applications;
  const id = settings?.gecko?.id;

  return typeof id === "string" && id ? id : null;
}

export function sessionProfilePath(projectPath: string, browser: string): string | null {
  try {
    const contract = JSON.parse(
      fs.readFileSync(readyContractPath(projectPath, browser), "utf8"),
    ) as Record<string, unknown>;

    return typeof contract.profilePath === "string" && contract.profilePath.trim()
      ? contract.profilePath
      : null;
  } catch {
    return null;
  }
}

export function readGeckoBaseUrlFromProfile(
  projectPath: string,
  browser: string,
): string | null {
  const addonId = geckoAddonId(projectPath, browser);
  const profile = sessionProfilePath(projectPath, browser);
  if (!addonId || !profile) return null;

  let prefs: string;

  try {
    prefs = fs.readFileSync(path.join(profile, "prefs.js"), "utf8");
  } catch {
    return null;
  }

  const match = UUIDS_PREF.exec(prefs);
  if (!match) return null;

  try {
    const map = JSON.parse(JSON.parse(`"${match[1]}"`)) as Record<string, unknown>;
    const uuid = map[addonId];

    return typeof uuid === "string" && uuid ? `moz-extension://${uuid}/` : null;
  } catch {
    return null;
  }
}
