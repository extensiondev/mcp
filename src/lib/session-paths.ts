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

const PROJECT_MANIFEST_FILENAMES = ["package.json", "deno.jsonc", "deno.json"];
const PACKAGE_MANIFEST = "package.json";
const DENO_MANIFESTS = ["deno.jsonc", "deno.json"];
const EXTENSION_DEPENDENCY_NAMES = ["extension", "extension-develop", "extension-create"];
const EXTENSION_CONFIG_FILENAMES = [
  "extension.config.js",
  "extension.config.mjs",
  "extension.config.cjs",
];

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function nearestAbove(startDir: string, names: string[]): string | null {
  let current = startDir;

  for (;;) {
    for (const name of names) {
      if (isFile(path.join(current, name))) return path.join(current, name);
    }

    const parent = path.dirname(current);
    if (parent === current) return null;

    current = parent;
  }
}

function extensionManifestPath(projectPath: string): string | null {
  const src = path.join(projectPath, "src", "manifest.json");
  if (isFile(src)) return src;

  const root = path.join(projectPath, "manifest.json");

  return isFile(root) ? root : null;
}

function declaresExtension(projectManifestPath: string): boolean {
  let parsed: unknown;

  try {
    parsed = JSON.parse(fs.readFileSync(projectManifestPath, "utf8"));
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== "object") return false;

  const record = parsed as Record<string, unknown>;
  const named: string[] = [];

  for (const field of ["dependencies", "devDependencies"]) {
    const deps = record[field];
    if (deps && typeof deps === "object") named.push(...Object.keys(deps));
  }

  const imports = record.imports;

  if (imports && typeof imports === "object") {
    for (const [key, value] of Object.entries(imports)) {
      named.push(key);
      if (typeof value === "string") named.push(value);
    }
  }

  return named.some((entry) =>
    EXTENSION_DEPENDENCY_NAMES.some(
      (name) => entry === name || entry.includes(`${name}@`) || entry === `npm:${name}`,
    ),
  );
}

export function ownsManifest(projectManifestPath: string, manifestPath: string): boolean {
  const projectDir = path.resolve(path.dirname(projectManifestPath));
  const manifestDir = path.resolve(path.dirname(manifestPath));
  if (projectDir === manifestDir) return true;

  if (path.basename(manifestDir) === "src" && path.dirname(manifestDir) === projectDir) {
    return true;
  }

  if (declaresExtension(projectManifestPath)) return true;

  return EXTENSION_CONFIG_FILENAMES.some((name) => isFile(path.join(projectDir, name)));
}

export function engineProjectRoot(projectPath: string): string {
  const start = path.resolve(projectPath);
  const manifest = extensionManifestPath(start);

  if (!manifest) {
    const nearest = nearestAbove(start, PROJECT_MANIFEST_FILENAMES);

    return nearest ? path.dirname(nearest) : start;
  }

  const manifestDir = path.dirname(manifest);
  const packageJson = nearestAbove(manifestDir, [PACKAGE_MANIFEST]);
  if (packageJson && ownsManifest(packageJson, manifest)) return path.dirname(packageJson);

  const deno = nearestAbove(manifestDir, DENO_MANIFESTS);
  if (deno && ownsManifest(deno, manifest)) return path.dirname(deno);

  return start;
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
