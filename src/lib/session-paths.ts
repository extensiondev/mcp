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

import * as bridge from "extension-develop/bridge";

import { readPackageVersion, resolveEngineOverride } from "./engine-override";
import { STORE_MD_FILENAME } from "./store-md";

import { dependencies } from "../../package.json";

const PACKAGE_MANIFEST = "package.json";
const DENO_MANIFESTS = ["deno.jsonc", "deno.json"];
const RELEASE = /^[\^~v]*(\d+)\.(\d+)\.\d+/;
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

function parsesAsJson(file: string): boolean {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));

    return true;
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

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

function runningEngineVersion(start: string): string | null {
  const override = resolveEngineOverride();
  if (override) return override.packageDir ? readPackageVersion(override.packageDir) : null;

  const modules = path.join(start, "node_modules");
  const bin = path.join(modules, ".bin", process.platform === "win32" ? "extension.cmd" : "extension");
  if (isExecutable(bin)) return readPackageVersion(path.join(modules, "extension"));

  return String(process.env.EXTENSION_MCP_CLI_VERSION || "").trim() || String(dependencies["extension-develop"] ?? "");
}

function runsAnEngineBeforeTheNamedFolderRule(start: string): boolean {
  const release = RELEASE.exec(String(runningEngineVersion(start) ?? "").trim());
  if (!release) return false;

  const major = Number(release[1]);

  return major < 4 || (major === 4 && Number(release[2]) < 2);
}

function rootBesideTheManifest(start: string): string | null {
  const src = path.join(start, "src");
  if (!isFile(path.join(src, "manifest.json"))) return null;
  if (parsesAsJson(path.join(start, PACKAGE_MANIFEST))) return null;
  if (DENO_MANIFESTS.some((name) => isFile(path.join(start, name)))) return null;

  return runsAnEngineBeforeTheNamedFolderRule(start) ? src : null;
}

/* @invariant ONE PROJECT ROOT AN ANSWER, THE ENGINE'S, ASKED AND NEVER
 * COPIED. The root is what the bundled engine's resolveSessionProjectRoot
 * answers: the MCP kept its own copy of that walk until 2026-11-20 and the
 * copy disagreed in four layouts (ledger 1025), so a good build was read as
 * no dist and a live session as no session. One difference between engines
 * is known and handled here: before Extension.js 4.2.0 a src/manifest.json
 * with no package.json or deno.json beside the folder passed was built from
 * src (ledger 925, 1026), so when the engine that will run is older, src is
 * the root. Which engine runs is read in the order exec.ts spawns one: an
 * engine override, the project's own binary, EXTENSION_MCP_CLI_VERSION, the
 * pin; exec.ts is not imported, so no test setup loads it before a mock.
 * Every dist and session path is read from this root; an answer whose root
 * is not the folder it was passed says so once. */
function resolvedRoot(projectPath: string): { start: string; root: string; besideManifest: boolean } {
  const start = path.resolve(projectPath);
  const root = bundledEngineRoot(start);
  const beside = root === start ? rootBesideTheManifest(start) : null;

  return { start, root: beside ?? root, besideManifest: beside !== null };
}

export function engineProjectRoot(projectPath: string): string {
  return resolvedRoot(projectPath).root;
}

export function projectRootNote(projectPath: string): string | null {
  const { start, root, besideManifest } = resolvedRoot(projectPath);
  if (root === start) return null;

  return besideManifest
    ? `Project root: ${root}, the manifest's folder, because the Extension.js that runs here is older than 4.2.0 and no package.json or deno.json sits beside src; dist and zips live there.`
    : `Project root: ${root}, the folder of the package.json or deno.json that owns this manifest; dist, zips and ${STORE_MD_FILENAME} live there.`;
}

export function statedProjectRoot(projectPath: string): { root: string; note: string } | null {
  const note = projectRootNote(projectPath);

  return note ? { root: engineProjectRoot(projectPath), note } : null;
}

function realPath(dir: string): string | null {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

/* @invariant THE REPOSITORY ROOT IS THE GIT TOP LEVEL OF THE PROJECT'S REAL
 * FOLDER, AND NEVER A HOME DIRECTORY. The walk starts from the real path, so
 * a project reached through a symbolic link is read against the repository
 * its files live in and never the one the link sits in. It stops at the
 * first folder that holds .git and looks no higher. A home directory or a
 * filesystem root that is itself a repository is refused: a STORE.md there
 * belongs to no project, and its text would be sent to the platform.
 */
function repositoryRoot(start: string): string | null {
  const real = realPath(start);
  if (!real) return null;

  const home = realPath(os.homedir());

  for (let dir = real; ; dir = path.dirname(dir)) {
    const top = path.dirname(dir) === dir;
    if (fs.existsSync(path.join(dir, ".git"))) return top || dir === home ? null : dir;
    if (top) return null;
  }
}

function repositoryAbove(root: string): string | null {
  const real = realPath(root);
  const repository = repositoryRoot(root);
  if (!real || !repository || repository === real) return null;

  const lexical = path.resolve(root, path.relative(real, repository));

  return realPath(lexical) === repository ? lexical : repository;
}

/* @invariant STORE.md IS FOUND IN THE ORDER THE BUILD LANE FINDS IT. The
 * lane reads the project's root directory first and the repository root
 * after it (ledger 1079), so a project in a subfolder of a repository may
 * keep one STORE.md at the top. Here the project's own folder is the folder
 * passed and then the engine's root, and the repository root is what
 * repositoryRoot answers. When no file exists anywhere the engine's root is
 * answered, the place a new one is written; an answer that read the
 * repository's file says so once.
 */
function storeMdRead(projectPath: string): { file: string; fromRepository: string | null } {
  const root = engineProjectRoot(projectPath);
  const own = [path.resolve(projectPath), root].map((dir) => path.join(dir, STORE_MD_FILENAME));
  const found = own.find(isFile);
  if (found) return { file: found, fromRepository: null };

  const repository = repositoryAbove(root);
  const shared = repository ? path.join(repository, STORE_MD_FILENAME) : null;

  return shared && isFile(shared) ? { file: shared, fromRepository: repository } : { file: own[1], fromRepository: null };
}

export function storeMdPath(projectPath: string): string {
  return storeMdRead(projectPath).file;
}

export function storeMdRepositoryNote(projectPath: string): string | null {
  const { file, fromRepository } = storeMdRead(projectPath);

  return fromRepository
    ? `${STORE_MD_FILENAME} read: ${file}, at the repository root, because ${engineProjectRoot(projectPath)} holds none. A ${STORE_MD_FILENAME} in the project's own folder is read first, here and by the build lane.`
    : null;
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
