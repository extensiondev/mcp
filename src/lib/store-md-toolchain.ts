// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { exactVersion } from "./exec";
import { scaffoldScripts } from "./scaffold-scripts";
import { buildSummaryPath } from "./session-paths";
import { isRow, text } from "./row";
import { STORE_MD_FILENAME, parseStoreMd, storeMdNamesStore } from "./store-md";

import type { ProjectFacts } from "./submit-facts";

type Row = Record<string, unknown>;

export type ToolchainProject = Pick<ProjectFacts, "projectPath" | "storeMd" | "toolchain">;

export const REVIEWER_NOTE_TOOLCHAIN_CHECK = "firefox.reviewer_note_toolchain";

export const REVIEWER_NOTE_SECTION = "## Firefox Add-ons";
export const REVIEWER_NOTE_HEADING = "### Reviewer notes";

const BUILD_SENTENCE = /Build from source with Node\b[\s\S]*?\.(?=\s|$)/;
const NODE_VERSION = /\bNode v?(\d+\.\d+\.\d+)/;
const PACKAGE_MANAGER = /\b(npm|pnpm|yarn|bun)\b(?:\s+v?(\d+\.\d+\.\d+))?/;
const EXTENSION_JS_VERSION = /\bExtension\.js v?(\d+\.\d+\.\d+)/;
const SEMVER = /(\d+\.\d+\.\d+)/;
const SAMPLE_INSTRUCTION = /\(replace both\b/i;
const LINE_WIDTH = 76;
const PROBE_TIMEOUT_MS = 5_000;
const SUMMARY_BROWSERS = ["firefox", "chromium", "chrome", "edge"];

export interface PackageManagerVersion {
  name: string;
  version?: string;
}

export interface Toolchain {
  node: string;
  packageManager?: PackageManagerVersion;
  extensionJs?: string;
}

export interface ReviewerNoteBuildLine extends Partial<Toolchain> {
  sentence: string;
  sample: boolean;
}

export interface BuiltToolchain {
  chain: Toolchain;
  from: string;
}

export interface ScaffoldToolchainNote extends Toolchain {
  file: string;
  buildCommand: string;
  sentence: string;
}

export function detectPackageManager(projectPath: string): string {
  const byLockfile: Array<[string, string]> = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];

  for (const [lockfile, pm] of byLockfile) {
    if (fs.existsSync(path.join(projectPath, lockfile))) return pm;
  }

  return "npm";
}

function readJson(file: string): Row | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));

    return isRow(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function toolchainOf(value: unknown): Toolchain | null {
  if (!isRow(value)) return null;

  const node = exactVersion(text(value.node));
  if (!SEMVER.test(node)) return null;

  const extensionJs = exactVersion(text(value.extensionJs) || text(value.extension_js));
  const pm = isRow(value.packageManager) ? value.packageManager : isRow(value.package_manager) ? value.package_manager : null;
  const name = pm ? text(pm.name) : "";
  const version = pm ? exactVersion(text(pm.version)) : "";

  return {
    node,
    ...(name ? { packageManager: { name, ...(SEMVER.test(version) ? { version } : {}) } } : {}),
    ...(SEMVER.test(extensionJs) ? { extensionJs } : {}),
  };
}

export function reviewerNoteBuildLine(notes: string): ReviewerNoteBuildLine | null {
  const sentence = BUILD_SENTENCE.exec(notes)?.[0];
  if (!sentence) return null;

  const node = NODE_VERSION.exec(sentence)?.[1];
  const pm = PACKAGE_MANAGER.exec(sentence);
  const extensionJs = EXTENSION_JS_VERSION.exec(sentence)?.[1];

  return {
    sentence,
    sample: SAMPLE_INSTRUCTION.test(sentence),
    ...(node ? { node } : {}),
    ...(pm ? { packageManager: { name: pm[1]!, ...(pm[2] ? { version: pm[2] } : {}) } } : {}),
    ...(extensionJs ? { extensionJs } : {}),
  };
}

export function toolchainWords(chain: Partial<Toolchain>): string {
  const pm = chain.packageManager;
  const parts = [
    chain.node ? `Node ${chain.node}` : null,
    pm ? `${pm.name}${pm.version ? ` ${pm.version}` : ""}` : null,
    chain.extensionJs ? `Extension.js ${chain.extensionJs}` : null,
  ].filter((part): part is string => part !== null);

  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "";
}

export function toolchainSentence(chain: Toolchain, commands: { install: string; build: string }): string {
  return `Build from source with ${toolchainWords(chain)}: run ${commands.install}, then ${commands.build}.`;
}

export function firefoxBuildScript(projectPath: string): string | null {
  return scaffoldScripts(projectPath, "npm").find((row) => row.browser === "firefox" && /\bbuild\b/.test(row.command))?.name ?? null;
}

export function firefoxBuildCommandOf(script: string | null, packageManager: string): string {
  if (script !== null) return `${packageManager} run ${script}`;

  if (packageManager === "npm") return "npx extension build --browser firefox";
  if (packageManager === "bun") return "bunx extension build --browser firefox";

  return `${packageManager} exec extension build --browser firefox`;
}

export function firefoxBuildCommand(projectPath: string, packageManager: string): string {
  return firefoxBuildCommandOf(firefoxBuildScript(projectPath), packageManager);
}

export function toolchainDifferences(note: Partial<Toolchain>, built: Toolchain): string[] {
  const differences: string[] = [];

  if (note.node && note.node !== built.node) differences.push("node");

  if (note.packageManager && built.packageManager) {
    if (note.packageManager.name !== built.packageManager.name) differences.push("packageManager");
    else if (note.packageManager.version && built.packageManager.version && note.packageManager.version !== built.packageManager.version) differences.push("packageManager");
  }

  if (note.extensionJs && built.extensionJs && note.extensionJs !== built.extensionJs) differences.push("extensionJs");

  return differences;
}

function wrapped(sentence: string): string {
  const lines: string[] = [];
  let line = "";

  for (const word of sentence.split(/\s+/)) {
    if (line && `${line} ${word}`.length > LINE_WIDTH) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }

  if (line) lines.push(line);

  return lines.join("\n");
}

function packageManagerVersion(name: string, cwd: string): Promise<string | undefined> {
  const agent = text(process.env.npm_config_user_agent);
  const fromAgent = new RegExp(`(?:^|\\s)${name}/(\\d+\\.\\d+\\.\\d+)`).exec(agent)?.[1];

  return new Promise((resolve) => {
    try {
      execFile(name, ["--version"], { cwd, timeout: PROBE_TIMEOUT_MS, shell: process.platform === "win32" }, (error, stdout) => {
        resolve((error ? undefined : SEMVER.exec(String(stdout))?.[1]) ?? fromAgent);
      });
    } catch {
      resolve(fromAgent);
    }
  });
}

function scaffoldExtensionJs(projectPath: string): string | undefined {
  const installed = readJson(path.join(projectPath, "node_modules", "extension", "package.json"));
  const installedVersion = installed ? exactVersion(text(installed.version)) : "";
  if (SEMVER.test(installedVersion)) return installedVersion;

  const pkg = readJson(path.join(projectPath, "package.json"));
  const dev = pkg && isRow(pkg.devDependencies) ? pkg.devDependencies.extension : undefined;
  const dep = pkg && isRow(pkg.dependencies) ? pkg.dependencies.extension : undefined;
  const pinned = exactVersion(text(dev) || text(dep));

  return /^\d+\.\d+\.\d+$/.test(pinned) ? pinned : undefined;
}

export async function writeScaffoldToolchainNote(projectPath: string, packageManager: string): Promise<ScaffoldToolchainNote | null> {
  const file = path.join(projectPath, STORE_MD_FILENAME);
  let content: string;

  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const found = BUILD_SENTENCE.exec(content);
  if (!found) return null;

  const version = await packageManagerVersion(packageManager, projectPath);
  const extensionJs = scaffoldExtensionJs(projectPath);
  const chain: Toolchain = {
    node: exactVersion(process.version),
    packageManager: { name: packageManager, ...(version ? { version } : {}) },
    ...(extensionJs ? { extensionJs } : {}),
  };
  const buildCommand = firefoxBuildCommand(projectPath, packageManager);
  const sentence = toolchainSentence(chain, { install: `${packageManager} install`, build: buildCommand });

  fs.writeFileSync(file, content.replace(found[0], wrapped(sentence)));

  return { ...chain, file, buildCommand, sentence };
}

export function localBuildToolchain(projectPath: string): BuiltToolchain | null {
  for (const browser of SUMMARY_BROWSERS) {
    let file: string;

    try {
      file = buildSummaryPath(projectPath, browser);
    } catch {
      continue;
    }

    const summary = readJson(file);
    const chain = summary ? toolchainOf(summary.toolchain) : null;
    if (chain) return { chain, from: `the local ${browser} build (extension_build)` };
  }

  return null;
}

/* @invariant THE REVIEWER NOTES OF A BUNDLED PACKAGE SAY HOW TO REBUILD IT.
 * Mozilla's source code submission policy
 * (https://extensionworkshop.com/documentation/publish/source-code-submission/)
 * asks for the source of any add-on whose code was minified, bundled into
 * one file or generated by a tool, attached to every version, with the
 * required versions of the tools and every command that reproduces the
 * package, because the reviewer rebuilds it and compares. The engine bundles
 * the scripts of every package it builds. The STORE.md guidance named the "### Reviewer
 * notes" heading and not what goes under it, and in 6 of 10 agent runs of
 * 2026-11-18 (ledger 947) the notes carried no build step, once as "No build
 * step is needed to review". The guidance now gives the line itself, in the
 * shape reviewerNoteToolchainCheck reads back, filled from the toolchain the
 * last build recorded when there is one, and asks for the source archive or
 * where the source is. Privacy and data-use answers stay the owner's.
 */
export const REVIEWER_NOTE_BUILD_SHAPE =
  "Build from source with Node <version>, <package manager> <version> and Extension.js <version>: run <install command>, then <build command>.";

export function reviewerNoteBuildSentence(projectPath: string): string | null {
  const built = localBuildToolchain(projectPath);
  if (!built) return null;

  const packageManager = built.chain.packageManager?.name || detectPackageManager(projectPath);

  return toolchainSentence(built.chain, { install: `${packageManager} install`, build: firefoxBuildCommand(projectPath, packageManager) });
}

export function firefoxReviewerNotesOf(content: string | null): string | null {
  if (content === null) return null;

  try {
    return parseStoreMd(content).firefox?.approvalNotes ?? null;
  } catch {
    return null;
  }
}

/* @invariant REVIEWER NOTES WITH NO BUILD LINE ARE A FINDING, NOT A PASS. The
 * check compared a build line that was there and answered nothing when the
 * notes held none, so the notes 6 of 10 agent runs wrote on 2026-11-18, with
 * no rebuild step, passed it (ledger 949). A STORE.md with a Firefox section
 * and no "Build from source with Node ..." line under its reviewer notes now
 * gets the same advisory warning a wrong line gets, with the line to write
 * filled from the last local build. A project with no STORE.md, or with no
 * Firefox section in it, is not asked: the missing-file line speaks for the
 * first and the second names no Firefox target.
 */
export function firefoxNotesLackBuildLine(content: string | null): boolean {
  if (content === null) return false;

  try {
    if (!storeMdNamesStore(content, "firefox")) return false;
  } catch {
    return false;
  }

  const notes = firefoxReviewerNotesOf(content);

  return !notes || reviewerNoteBuildLine(notes) === null;
}

const NO_BUILD_READ = 'No build toolchain was read to fill it: run extension_build with browser "firefox" once, and this check names the line to write.';

export function reviewerNoteToolchainCheck(project: ToolchainProject): Row | null {
  if (!project.projectPath) return null;

  const built = project.toolchain?.localBuild ?? null;

  const notes = firefoxReviewerNotesOf(project.storeMd);
  const line = notes ? reviewerNoteBuildLine(notes) : null;
  if (!line && !firefoxNotesLackBuildLine(project.storeMd)) return null;

  const differences = line && built ? toolchainDifferences(line, built.chain) : [];
  if (line && !line.sample && !differences.length) return null;

  const packageManager = built?.chain.packageManager?.name || line?.packageManager?.name || (project.toolchain?.packageManager ?? "npm");
  const replacement = built ? toolchainSentence(built.chain, { install: `${packageManager} install`, build: firefoxBuildCommandOf(project.toolchain?.firefoxBuildScript ?? null, packageManager) }) : null;

  if (!line) {
    const place = `\`${REVIEWER_NOTE_HEADING}\` in \`${REVIEWER_NOTE_SECTION}\` of ${STORE_MD_FILENAME}`;

    return {
      id: REVIEWER_NOTE_TOOLCHAIN_CHECK,
      label: "The Firefox reviewer note names the toolchain that built the upload",
      status: "warn",
      severity: "advisory",
      stage: "review",
      expected: replacement ?? "the Node, package manager and Extension.js versions of the build that is uploaded",
      actual: "no build line",
      message: `The Firefox reviewer note in ${STORE_MD_FILENAME} has no build line, and Mozilla's reviewers rebuild a bundled add-on from that line. ${replacement ? `Write under ${place}: ${replacement}` : NO_BUILD_READ}`,
      ...(built ? { built: { from: built.from, ...built.chain } } : {}),
      write: {
        file: STORE_MD_FILENAME,
        section: REVIEWER_NOTE_SECTION,
        heading: REVIEWER_NOTE_HEADING,
        ...(replacement ? { with: replacement } : {}),
      },
    };
  }

  const said = toolchainWords(line) || "no versions";
  const ran = built ? `${built.from} ran ${toolchainWords(built.chain)}` : "";
  const where = `the sentence under \`${REVIEWER_NOTE_HEADING}\` in \`${REVIEWER_NOTE_SECTION}\` of ${STORE_MD_FILENAME}`;
  const fix = replacement ? `Replace ${where} with: ${replacement}` : NO_BUILD_READ;
  const message = line.sample
    ? `The Firefox reviewer note in ${STORE_MD_FILENAME} still carries the template's sample build line (${said}, with the "replace both" instruction), and Mozilla's reviewers rebuild the add-on from that line.${ran ? ` ${ran}.` : ""} ${fix}`
    : `The Firefox reviewer note in ${STORE_MD_FILENAME} says ${said}, and ${ran}; Mozilla's reviewers rebuild the add-on from the note, so a version it misstates fails the source review. ${fix}`;

  return {
    id: REVIEWER_NOTE_TOOLCHAIN_CHECK,
    label: "The Firefox reviewer note names the toolchain that built the upload",
    status: "warn",
    severity: "advisory",
    stage: "review",
    expected: replacement ?? "the Node, package manager and Extension.js versions of the build that is uploaded",
    actual: said,
    message,
    ...(built ? { built: { from: built.from, ...built.chain } } : {}),
    write: {
      file: STORE_MD_FILENAME,
      section: REVIEWER_NOTE_SECTION,
      heading: REVIEWER_NOTE_HEADING,
      replace: line.sentence,
      ...(replacement ? { with: replacement } : {}),
    },
  };
}
