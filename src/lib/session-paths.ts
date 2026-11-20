// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import * as bridge from "extension-develop/bridge";

import { STORE_MD_FILENAME } from "./store-md";

export const EXTENSION_CONFIG_FILENAMES = [
  "extension.config.js",
  "extension.config.mjs",
  "extension.config.cjs",
];

export function posixPath(file: string): string {
  return file.replace(/\\/g, "/");
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function extensionManifestPath(projectPath: string): string | null {
  const src = path.join(projectPath, "src", "manifest.json");
  if (isFile(src)) return src;

  const root = path.join(projectPath, "manifest.json");

  return isFile(root) ? root : null;
}

function bundledEngineRoot(start: string): string {
  const warn = console.warn;

  console.warn = () => {};

  try {
    return bridge.resolveSessionProjectRoot(start);
  } finally {
    console.warn = warn;
  }
}

/* @invariant ONE PROJECT ROOT AN ANSWER, THE ENGINE'S, ASKED AND NEVER
 * COPIED. The root is what the bundled engine's resolveSessionProjectRoot
 * answers: the MCP kept its own copy of that walk until 2026-11-20 and the
 * copy disagreed in four layouts (ledger 1025), so a good build was read as
 * no dist and a live session as no session. Every dist and session path is
 * read from this root; an answer whose root is not the folder it was passed
 * says so once. */
export function engineProjectRoot(projectPath: string): string {
  return bundledEngineRoot(path.resolve(projectPath));
}

export function projectRootNote(projectPath: string): string | null {
  const start = path.resolve(projectPath);
  const root = engineProjectRoot(start);
  if (root === start) return null;

  return `Project root: ${root}, the folder of the package.json or deno.json that owns this manifest; dist, zips and ${STORE_MD_FILENAME} live there.`;
}

export function statedProjectRoot(projectPath: string): { root: string; note: string } | null {
  const note = projectRootNote(projectPath);

  return note ? { root: engineProjectRoot(projectPath), note } : null;
}

export function storeMdPath(projectPath: string): string {
  const passed = path.join(path.resolve(projectPath), STORE_MD_FILENAME);

  return isFile(passed) ? passed : path.join(engineProjectRoot(projectPath), STORE_MD_FILENAME);
}

export function sourceManifestPath(projectPath: string): string | null {
  return extensionManifestPath(engineProjectRoot(projectPath)) ?? extensionManifestPath(path.resolve(projectPath));
}

const rooted =
  <T extends unknown[], R>(fn: (projectPath: string, ...rest: T) => R) =>
  (projectPath: string, ...rest: T): R =>
    fn(engineProjectRoot(projectPath), ...rest);

export const actionsPath = rooted(bridge.actionsPath);
export const browserArtifactsDir = rooted(bridge.browserArtifactsDir);
export const buildSummaryPath = rooted(bridge.buildSummaryPath);
export const eventsPath = rooted(bridge.eventsPath);
export const logsPath = rooted(bridge.logsPath);
export const readyContractPath = rooted(bridge.readyContractPath);
export const sessionArtifactsRootDir = rooted(bridge.sessionArtifactsRootDir);
export const sessionStateDir = rooted(bridge.sessionStateDir);

export {
  readReadyContract,
  type ReadyContractInfo,
} from "extension-develop/bridge";

export function evalTokenPresent(projectPath: string, browser: string): boolean {
  return Boolean(
    bridge.readControlToken(engineProjectRoot(projectPath), browser),
  );
}

export function sessionPathHint(file: string): string {
  return `Looked at ${file} (the session-state layout this MCP's pinned engine publishes). If the project runs an older Extension.js, its layout may differ and this path will never appear.`;
}

export function profilesRootDir(projectPath: string): string {
  return path.join(sessionArtifactsRootDir(projectPath), "profiles");
}

export function browserProfileRootDir(
  projectPath: string,
  browser: string,
): string {
  return path.join(profilesRootDir(projectPath), `${browser}-profile`);
}

export const PERSISTED_PROFILE_DIR_NAME = "dev";

export interface ProfileRemediationInput {
  projectPath: string;
  browser: string;
  profile?: string;
}

export function profileRemediation(input: ProfileRemediationInput): string {
  const { projectPath, browser, profile } = input;
  const raw = typeof profile === "string" ? profile.trim() : "";

  if (raw.toLowerCase() === "false") {
    return `This session was launched with profile:"false", so it runs your real ${browser} profile and there is no Extension.js profile directory to remove. Quit the ${browser} window that holds it and start again.`;
  }

  if (raw.length > 0) {
    const explicit = path.isAbsolute(raw) ? raw : path.resolve(projectPath, raw);

    return `This session was launched against the profile you passed, ${explicit}. Close whatever still holds it, or remove that directory, before retrying.`;
  }

  const root = browserProfileRootDir(projectPath, browser);

  return `The engine keeps this session's profile in a directory inside ${root}, one per run: "${PERSISTED_PROFILE_DIR_NAME}" when the profile is persisted, otherwise three random words drawn fresh on every start, which no caller can predict. List ${root} to see which run directories exist and remove the one the stuck browser holds, or remove ${root} entirely once no session is running.`;
}
