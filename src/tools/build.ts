// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { LAUNCH_BROWSER, PROJECT_PATH } from "../lib/common-schema";
import { runExtensionCli } from "../lib/exec";
import { compareVersions, outputJsonVerdict, refusedTheOutputFlag, resolvedEngineFacts } from "../lib/engine-version";
import { liveProjectSessions } from "../lib/session-browser";
import { channelAwareBuildWarnings } from "../lib/amo-update-url";
import { CARRIER_DIR_NAME, removeCarrier } from "../lib/carrier";
import { readZipEntryNames } from "../lib/zip-entries";
import { LARGE_ASSET_FLOOR, duplicateAssetSentence, findDuplicateAssets, largestFilesOf, listDistFiles } from "../lib/duplicate-assets";
import {
  buildSummaryPath,
  readyContractPath,
  sessionPathHint,
  engineProjectRoot,
} from "../lib/session-paths";
import { type Envelope, envelope, isEnvelope } from "../lib/envelope";
import { platformListed } from "../lib/tool-policy";
import { manifestDivergence } from "../lib/manifest-by-browser";
import { droppedRuntimePages, isDroppedRuntimePageWarning } from "../lib/dropped-runtime-pages";
import { specialFolderEntrypoints, specialFolderMissingNote } from "../lib/special-folder-entries";
import { engineBrowserName } from "../lib/browser-family";
import { BUNDLE_ID_PATTERN, isSafariTarget } from "../lib/safari-dev-options";
import {
  SAFARI_BUILD_OPTION_SCHEMA,
  buildBudgetMs,
  buildTimeoutWords,
  keptTeamNote,
  safariBuildCliArgs,
  safariBuildRefusal,
  safariBuildTeam,
  type SafariBuildArgs,
} from "../lib/safari-build-options";
import { safariSigningFrame } from "../lib/safari-signing";
import { teamUnknownToXcodeRefusal } from "../lib/xcode-teams";
import { reviewCoverageNotes, reviewDistReport, reviewRiskWarnings } from "../lib/store-review";

const COMMAND = "extension_build";
const DEV_SESSION_OWNS_THE_DIST = "E_DEV_SESSION_DIST_SHARED" as const;
export const OUT_DIR_FLOOR = "4.1.36";

const OUT_DIR_REFUSED = /unknown option '--out-dir'|--out-dir/i;

export function resolveBuildOutDir(projectPath: string, outDir: string | undefined): string | null {
  const wanted = typeof outDir === "string" ? outDir.trim() : "";

  return wanted ? path.resolve(projectPath, wanted) : null;
}

function outDirRefusal(projectPath: string, outDir: string): string | null {
  const resolved = resolveBuildOutDir(projectPath, outDir);
  if (!resolved) return null;

  if (resolved === path.resolve(projectPath)) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "bad-request",
      error: {
        code: "E_BAD_REQUEST",
        message: `outDir ${JSON.stringify(outDir)} is the project root; the build writes <outDir>/<browser>, so it needs a folder other than the project itself.`,
      },
      hint: 'Pass a folder such as outDir: "build", which writes build/<browser> and the zip beside it.',
    });
  }

  return null;
}

async function outDirEngineRefusal(projectPath: string): Promise<string | null> {
  let version: string | null;

  try {
    version = (await resolvedEngineFacts(projectPath)).version;
  } catch {
    return null;
  }

  if (version === null || (compareVersions(version, OUT_DIR_FLOOR) ?? 0) >= 0) return null;

  return envelope({
    ok: false,
    command: COMMAND,
    status: "engine-unsupported",
    error: {
      code: "E_ENGINE_TOO_OLD",
      message: `The project's Extension.js engine reports ${version}, and extension build takes --out-dir only from ${OUT_DIR_FLOOR} on, so outDir cannot be honored. Nothing was built.`,
    },
    hint: `Upgrade the project's engine (npm i -D extension@latest) to build into outDir, or build without outDir after extension_stop on the session that serves dist/<browser>.`,
  });
}

function devSessionOwnsOutputRefusal(browser: string, pids: number[], start: number): string {
  const who = pids.length === 1 ? `A live dev session (pid ${pids[0]})` : `Live dev sessions (pids ${pids.join(", ")})`;

  return envelope({
    ok: false,
    command: COMMAND,
    status: "build-refused",
    error: {
      code: DEV_SESSION_OWNS_THE_DIST,
      message: `${who} for ${browser} ${pids.length === 1 ? "is" : "are"} running on this project and ${pids.length === 1 ? "serves" : "serve"} dist/${browser}, the folder this build would write. A production bundle written over it pulls the files out from under that browser, so nothing was built and the session is untouched.`,
    },
    value: { browser, duration: Date.now() - start, livePids: pids, outputPath: `dist/${browser}` },
    hint: `Pass outDir (for example "build", which writes build/${browser} and the zip beside it, and leaves dist/${browser} to the session) to build next to the session, or call extension_stop with this projectPath and browser "${browser}" first.`,
  });
}

interface EngineSafariSummary {
  appName?: string;
  bundleId?: string;
  bundleIdDerived?: boolean;
  appPath?: string;
  xcodeProjectPath?: string;
  macOsOnly?: boolean;
}

interface EngineBuildSummary {
  browser?: string;
  output_path?: string;
  total_assets?: number;
  total_bytes?: number;
  largest_asset_bytes?: number;
  warnings_count?: number;
  errors_count?: number;
  warnings?: string[];
  safari?: EngineSafariSummary;
  zip_artifacts?: Array<{ kind?: string; path?: string; size?: number }>;
  addon_lint?: EngineAddonLint;
  toolchain?: EngineToolchain;
}

interface EngineAddonLint {
  status?: string;
  findings?: number;
  reason?: string;
}

interface EngineToolchain {
  node?: string;
  extension_js?: string;
  package_manager?: { name?: string; version?: string };
}

export const AMO_REVIEWER_NOTE = "amo-reviewer-note.md";

export const ADDON_LINT_INSTALL = "npm install -D addons-linter";

export interface AddonLintValue {
  status: "linted" | "missing" | "failed" | "skipped";
  findings?: number;
  reason?: string;
  reviewerNotePath?: string;
  installHint?: string;
}

/* @invariant A SKIPPED AMO LINT IS AN ANSWER, NOT A SILENCE. The engine
 * records summary.addon_lint on every build (linted with a count, missing
 * when addons-linter is not installed, failed, or skipped by mode, browser
 * or config) and prints the missing case as one info line that this tool
 * never relayed; and its writer removes dist/amo-reviewer-note.md only when
 * a lint ran and found nothing, so the missing path leaves an earlier run's
 * note beside a new dist. A Firefox build therefore answered clean while a
 * stale note sat there (ledger 425). The answer carries value.addonLint, a
 * missing lint is a warning with the install line and the config key, and a
 * note older than this build is named as stale. The toolchain the engine
 * writes beside it (node, package manager, Extension.js) is answered as
 * value.toolchain instead of being a sentence the person is told to copy
 * into a reviewer note by hand (ledger 424). */
export function addonLintFrame(summary: EngineBuildSummary | null, distRoot: string, since: number): { value: AddonLintValue | null; warnings: string[] } {
  const lint = summary?.addon_lint;
  const status = typeof lint?.status === "string" ? lint.status : "";
  if (!lint || !["linted", "missing", "failed", "skipped"].includes(status)) return { value: null, warnings: [] };

  const notePath = path.join(distRoot, AMO_REVIEWER_NOTE);
  let noteWrittenAt: number | null = null;

  try {
    noteWrittenAt = fs.statSync(notePath).mtimeMs;
  } catch {
  }

  const noteIsCurrent = noteWrittenAt !== null && noteWrittenAt >= since - COARSE_MTIME_CLOCK_SLACK_MS;
  const warnings: string[] = [];

  if (status === "missing") {
    warnings.push(
      `The addons.mozilla.org lint did not run: addons-linter is not installed in this project, so this answer carries no AMO findings for the package. Install it (${ADDON_LINT_INSTALL}) and build again, or set commands.build.addonLint to false in extension.config.js (the --no-addon-lint flag) to skip it on purpose.`,
    );
  }

  if (status === "failed") {
    warnings.push(`The addons.mozilla.org lint failed to run${lint.reason ? ` (${lint.reason})` : ""}, so this answer carries no AMO findings for the package.`);
  }

  if (noteWrittenAt !== null && !noteIsCurrent && status !== "linted") {
    warnings.push(
      `${notePath} was written by an earlier build (${new Date(noteWrittenAt).toISOString()}), not by this one: the lint that writes it did not run now, so its findings are stale and do not describe this package.`,
    );
  }

  return {
    value: {
      status: status as AddonLintValue["status"],
      ...(typeof lint.findings === "number" ? { findings: lint.findings } : {}),
      ...(lint.reason ? { reason: lint.reason } : {}),
      ...(noteIsCurrent ? { reviewerNotePath: notePath } : {}),
      ...(status === "missing" ? { installHint: ADDON_LINT_INSTALL } : {}),
    },
    warnings,
  };
}

export function toolchainValue(summary: EngineBuildSummary | null): { node: string; extensionJs?: string; packageManager?: { name: string; version: string } } | null {
  const chain = summary?.toolchain;
  if (!chain || typeof chain.node !== "string" || !chain.node) return null;

  const pm = chain.package_manager;

  return {
    node: chain.node,
    ...(typeof chain.extension_js === "string" && chain.extension_js ? { extensionJs: chain.extension_js } : {}),
    ...(pm && typeof pm.name === "string" && typeof pm.version === "string" ? { packageManager: { name: pm.name, version: pm.version } } : {}),
  };
}

interface PersistedSummary {
  file: string;
  summary: EngineBuildSummary | null;
}

function readBuildSummary(
  projectPath: string,
  browser: string,
  since: number,
): PersistedSummary {
  const file = buildSummaryPath(projectPath, browser);

  try {
    const stat = fs.statSync(file);

    if (stat.mtimeMs >= since - COARSE_MTIME_CLOCK_SLACK_MS) {
      const summary = JSON.parse(fs.readFileSync(file, "utf8"));
      if (summary && typeof summary === "object") return { file, summary };
    }
  } catch {}

  return { file, summary: null };
}

interface EngineOutput {
  frame: Envelope | null;
  narration: string;
}

function readEngineOutput(stdout: string, stderr: string): EngineOutput {
  let frame: Envelope | null = null;
  const rest: string[] = [];

  for (const line of stdout.split("\n")) {
    const text = line.trim();

    if (!frame && text.startsWith("{")) {
      let parsed: unknown = null;

      try {
        parsed = JSON.parse(text);
      } catch {}

      if (isEnvelope(parsed)) {
        frame = parsed;
        continue;
      }
    }

    rest.push(line);
  }

  const narration = [rest.join("\n").trim(), stderr.trim()]
    .filter(Boolean)
    .join("\n");

  return { frame, narration };
}

export type BuildMode = "development" | "production" | "none";

const BUILD_MODES = new Set<string>(["development", "production", "none"]);

const NARRATED_MODE = /built for (development|production)\b/i;

/* @invariant THE ANSWER NAMES THE MODE THE ENGINE BUILT, NOT THE ONE ASKED
 * FOR. extension build --output json records `value.mode` as the mode the
 * build resolved to (production when no --mode was passed), and its narration
 * says "Extension built for <mode> in dist/<browser>"; a development and a
 * production build of one browser land in the same dist/<browser> unless
 * outDir separates them, so after two builds nothing else says which one is
 * there (ledger 419). The frame's word comes first, the narration second, and
 * only an engine that says neither is taken at the argument's word. */
export function builtMode(frame: Envelope | null, narration: string, requested: BuildMode | undefined): BuildMode {
  const recorded = (frame?.value as { mode?: unknown } | null | undefined)?.mode;
  if (typeof recorded === "string" && BUILD_MODES.has(recorded)) return recorded as BuildMode;

  const said = NARRATED_MODE.exec(narration)?.[1]?.toLowerCase();
  if (said === "development" || said === "production") return said;

  return requested ?? "production";
}

export function modeSentence(mode: BuildMode): string {
  if (mode === "development") {
    return "This is a development build (readable code, source maps, NODE_ENV=development), the one Playwright and e2e harnesses load; a store takes the production build, which extension_build makes without mode.";
  }

  return mode === "none" ? "This build ran with the bundler's mode unset (mode: \"none\")." : "";
}

function engineSummaries(frame: Envelope | null): EngineBuildSummary[] {
  const value = frame?.value as { summaries?: unknown } | null | undefined;
  if (!value || !Array.isArray(value.summaries)) return [];

  return value.summaries.filter(
    (entry): entry is EngineBuildSummary =>
      Boolean(entry) && typeof entry === "object",
  );
}

function summaryForBrowser(
  summaries: EngineBuildSummary[],
  browser: string,
): EngineBuildSummary | null {
  return (
    summaries.find((entry) => entry.browser === browser) ?? summaries[0] ?? null
  );
}

function builtEntrypoints(
  distDir: string,
): Array<{ role: string; path: string; present: boolean }> {
  let manifest: Record<string, unknown>;

  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(distDir, "manifest.json"), "utf8"),
    );
  } catch {
    return [];
  }

  const out: Array<{ role: string; path: string; present: boolean }> = [];

  const add = (role: string, ref: unknown) => {
    if (typeof ref !== "string") return;

    out.push({
      role,
      path: ref,
      present: fs.existsSync(path.join(distDir, ref.replace(/^\.?\//, ""))),
    });
  };

  const bg = manifest.background as Record<string, unknown> | undefined;
  if (bg?.service_worker) add("background.service_worker", bg.service_worker);
  if (bg?.page) add("background.page", bg.page);

  if (Array.isArray(bg?.scripts))
    {bg.scripts.forEach((s) => add("background.scripts", s));}

  const action = (manifest.action || manifest.browser_action) as
    | Record<string, unknown>
    | undefined;
  if (action?.default_popup) add("action.default_popup", action.default_popup);

  const pageAction = manifest.page_action as
    | Record<string, unknown>
    | undefined;

  if (pageAction?.default_popup)
    {add("page_action.default_popup", pageAction.default_popup);}

  const cs = manifest.content_scripts as
    | Array<Record<string, unknown>>
    | undefined;

  if (Array.isArray(cs)) {
    cs.forEach((c, i) => {
      if (Array.isArray(c.js))
        {c.js.forEach((j) => add(`content_scripts[${i}].js`, j));}

      if (Array.isArray(c.css))
        {c.css.forEach((s) => add(`content_scripts[${i}].css`, s));}
    });
  }

  add("devtools_page", manifest.devtools_page);
  add("options_page", manifest.options_page);
  const optionsUi = manifest.options_ui as Record<string, unknown> | undefined;
  if (optionsUi?.page) add("options_ui.page", optionsUi.page);

  const sidePanel = manifest.side_panel as Record<string, unknown> | undefined;

  if (sidePanel?.default_path)
    {add("side_panel.default_path", sidePanel.default_path);}

  const sidebarAction = manifest.sidebar_action as
    | Record<string, unknown>
    | undefined;

  if (sidebarAction?.default_panel)
    {add("sidebar_action.default_panel", sidebarAction.default_panel);}

  const overrides = manifest.chrome_url_overrides as
    | Record<string, unknown>
    | undefined;

  if (overrides) {
    for (const [key, ref] of Object.entries(overrides)) {
      add(`chrome_url_overrides.${key}`, ref);
    }
  }

  const dnr = manifest.declarative_net_request as
    | Record<string, unknown>
    | undefined;

  if (dnr && Array.isArray(dnr.rule_resources)) {
    dnr.rule_resources.forEach((r, i) => {
      if (r && typeof r === "object") {
        add(
          `declarative_net_request[${i}].path`,
          (r as Record<string, unknown>).path,
        );
      }
    });
  }

  return out;
}

function engineSanitize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9 ]/gi, "")
    .trim()
    .replace(/\s+/g, "-");
}

function newestZip(
  dir: string,
  since: number,
  match?: (name: string) => boolean,
): string | null {
  try {
    const fresh = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".zip") && (!match || match(name)))
      .map((name) => {
        const full = path.join(dir, name);

        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .filter((entry) => entry.mtimeMs >= since - COARSE_MTIME_CLOCK_SLACK_MS)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return fresh[0]?.full ?? null;
  } catch {
    return null;
  }
}

function engineZipBase(distDir: string, projectPath: string): string {
  let manifest: Record<string, unknown> = {};

  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(distDir, "manifest.json"), "utf8"),
    );
  } catch {}

  const rawName =
    typeof manifest.name === "string" && !/^__MSG_.+__$/.test(manifest.name)
      ? manifest.name
      : path.basename(path.resolve(projectPath));
  const version =
    typeof manifest.version === "string" && manifest.version
      ? manifest.version
      : "0.0.0";

  return `${engineSanitize(rawName)}-${version}`;
}

function zipFromSummary(
  summary: EngineBuildSummary | null,
  kind: "dist" | "source",
  since: number,
): string | null {
  for (const artifact of summary?.zip_artifacts ?? []) {
    if (artifact?.kind !== kind || typeof artifact.path !== "string") continue;
    if (freshFile(artifact.path, since)) return artifact.path;
  }

  return null;
}

const COARSE_MTIME_CLOCK_SLACK_MS = 1000;

function freshFile(file: string, since: number): boolean {
  try {
    return fs.statSync(file).mtimeMs >= since - COARSE_MTIME_CLOCK_SLACK_MS;
  } catch {
    return false;
  }
}

function explicitZipStem(zipFilename: string): string {
  const flat = path.basename(zipFilename.trim());
  const safe = [...flat]
    .filter((ch) => !'<>:"/\\|?*'.includes(ch) && ch.charCodeAt(0) > 0x1f)
    .join("")
    .replace(/\.+$/, "")
    .trim();

  return (safe || "extension").replace(/\.zip$/i, "");
}

function locateDistZip(
  projectPath: string,
  distRoot: string,
  browser: string,
  zipFilename: string | undefined,
  since: number,
  summary: EngineBuildSummary | null,
): string | null {
  const fromSummary = zipFromSummary(summary, "dist", since);
  if (fromSummary) return fromSummary;

  const distDir = path.resolve(distRoot, engineBrowserName(browser));
  const stem = zipFilename
    ? explicitZipStem(zipFilename)
    : engineZipBase(distDir, projectPath);
  const suffix = `-${browser}`;
  const named = stem.toLowerCase().endsWith(suffix) ? stem : `${stem}${suffix}`;
  const expected = path.join(distRoot, `${named}.zip`);
  if (freshFile(expected, since)) return expected;

  return (
    newestZip(
      distRoot,
      since,
      (name) => name.toLowerCase().endsWith(`${suffix}.zip`),
    ) ??
    newestZip(distDir, since)
  );
}

function locateSourceZip(
  projectPath: string,
  distRoot: string,
  browser: string,
  zipFilename: string | undefined,
  since: number,
  summary: EngineBuildSummary | null,
): string | null {
  const fromSummary = zipFromSummary(summary, "source", since);
  if (fromSummary) return fromSummary;

  const distDir = path.resolve(distRoot, engineBrowserName(browser));
  const stem = zipFilename
    ? explicitZipStem(zipFilename)
    : engineZipBase(distDir, projectPath);
  const expected = path.join(distRoot, `${stem}-source.zip`);
  if (freshFile(expected, since)) return expected;

  return newestZip(distRoot, since, (name) => name.endsWith("-source.zip"));
}

export const schema = {
  name: "extension_build",
  description:
    "Build the extension on this machine into dist/<browser>/; never for sharing (extension_builds). Refuses a dist a dev session serves unless outDir.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: PROJECT_PATH,
      browser: LAUNCH_BROWSER,
      zip: {
        type: "boolean",
        default: false,
        description: "Also write a .zip.",
      },
      zipSource: {
        type: "boolean",
        default: false,
        description: "Also zip the source.",
      },
      zipFilename: {
        type: "string",
        description: "Zip file name.",
      },
      polyfill: {
        type: "boolean",
        default: false,
        description: "Cross-browser polyfill.",
      },
      silent: {
        type: "boolean",
        default: false,
        description: "Suppress build output.",
      },
      mode: {
        type: "string",
        enum: ["development", "production", "none"],
        default: "production",
        description:
          "development: readable, source maps (with outDir); none: unset.",
      },
      skipValidation: {
        type: "boolean",
        default: false,
        description:
          "Build despite manifest errors.",
      },
      outDir: {
        type: "string",
        description:
          "Build folder instead of dist (Extension.js 4.1.36+).",
      },
      ...SAFARI_BUILD_OPTION_SCHEMA,
    },
    required: ["projectPath"],
  },
};

export { BUNDLE_ID_PATTERN };

const MARKER_FILE_NAME = "managed-by-extension-dev-mcp.json";

interface Contamination {
  paths: string[];
  unchecked: string[];
}

function namesCarrier(entryName: string): boolean {
  return entryName === CARRIER_DIR_NAME || entryName === MARKER_FILE_NAME;
}

function carrierEntriesInZip(zipPath: string): Contamination {
  const listing = readZipEntryNames(zipPath);
  if (!listing.readable) return { paths: [], unchecked: [zipPath] };

  const hits = listing.names
    .filter((name) => name.split("/").some(namesCarrier))
    .map((name) => `${zipPath} -> ${name}`);

  return { paths: hits, unchecked: [] };
}

function carrierContamination(dir: string, depth = 0): Contamination {
  if (depth > 4) return { paths: [], unchecked: [] };

  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { paths: [], unchecked: [] };
  }

  const found: Contamination = { paths: [], unchecked: [] };

  const absorb = (other: Contamination) => {
    found.paths.push(...other.paths);
    found.unchecked.push(...other.unchecked);
  };

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (namesCarrier(entry.name)) {
      found.paths.push(full);
      continue;
    }

    if (entry.isDirectory()) {
      absorb(carrierContamination(full, depth + 1));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".zip")) {
      absorb(carrierEntriesInZip(full));
    }
  }

  return found;
}

interface ValidationPreflight {
  valid: boolean;
  buildBlocking: boolean;
  errors: string[];
  warnings: string[];
}

type PreflightOutcome =
  | { state: "ran"; preflight: ValidationPreflight }
  | { state: "could-not-run"; reason: string };

async function validationPreflight(
  projectPath: string,
  browser: string,
): Promise<PreflightOutcome> {
  try {
    const manifestValidate = await import("./manifest-validate");
    const parsed = JSON.parse(
      await manifestValidate.handler({ projectPath, browsers: [browser] }),
    );

    if (
      parsed?.ok === false &&
      /^manifest-(unreadable|not-found)$/.test(String(parsed?.status ?? ""))
    ) {
      return {
        state: "could-not-run",
        reason: String(parsed?.error?.message || parsed?.status || "the validator refused"),
      };
    }

    const value = parsed?.value ?? {};

    return {
      state: "ran",
      preflight: {
        valid: Boolean(value.valid),
        buildBlocking: Boolean(value.buildBlocking),
        errors: Array.isArray(value.errors) ? value.errors : [],
        warnings: Array.isArray(value.warnings) ? value.warnings : [],
      },
    };
  } catch (err) {
    return {
      state: "could-not-run",
      reason: `the validator threw: ${(err as Error)?.message ?? String(err)}`,
    };
  }
}

export async function handler(args: {
  projectPath: string;
  browser?: string;
  zip?: boolean;
  zipSource?: boolean;
  zipFilename?: string;
  polyfill?: boolean;
  silent?: boolean;
  mode?: "development" | "production" | "none";
  skipValidation?: boolean;
  outDir?: string;
} & SafariBuildArgs): Promise<string> {
  const start = Date.now();
  const browser = args.browser ?? "chrome";
  const safari = isSafariTarget(browser);
  const safariRefusal = safariBuildRefusal(COMMAND, browser, args, start);
  if (safariRefusal) return safariRefusal;

  const outDir = resolveBuildOutDir(args.projectPath, args.outDir);

  if (outDir) {
    const invalid = outDirRefusal(args.projectPath, String(args.outDir));
    if (invalid) return invalid;

    const tooOld = await outDirEngineRefusal(args.projectPath);
    if (tooOld) return tooOld;
  }

  const liveSameBrowser = liveProjectSessions(args.projectPath).filter((session) => session.browser === browser);

  if (!outDir && liveSameBrowser.length) {
    return devSessionOwnsOutputRefusal(browser, liveSameBrowser.map((session) => session.pid), start);
  }

  const signingTeam = safariBuildTeam(args.projectPath, browser, args.developmentTeam);
  const teamRefusal = await teamUnknownToXcodeRefusal(COMMAND, browser, signingTeam.team, start);
  if (teamRefusal) return teamRefusal;

  const carrierCleanup = removeCarrier(args.projectPath);
  const carrierNotes: string[] = [];

  if (carrierCleanup.removed) {
    carrierNotes.push(
      "Removed the Extension.dev live-preview carrier from ./extensions before building. It is a debug companion, not part of your extension; run extension_dev with carrier: true to get it back.",
    );
  } else if (carrierCleanup.note) {
    carrierNotes.push(carrierCleanup.note);
  }

  const preflightOutcome = args.skipValidation
    ? null
    : await validationPreflight(args.projectPath, browser);
  const preflight =
    preflightOutcome?.state === "ran" ? preflightOutcome.preflight : null;

  if (preflightOutcome?.state === "could-not-run") {
    carrierNotes.push(
      `Manifest validation did not run before this build (${preflightOutcome.reason}), so nothing below was checked against the manifest rules. Run extension_manifest_validate on its own to see why.`,
    );
  }

  if (preflight?.buildBlocking) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "manifest-blocked",
      error: {
        code: "E_MANIFEST_BLOCKING",
        message:
          "Build refused: the manifest has errors that produce a broken extension even when the bundler succeeds.",
      },
      value: {
        browser,
        errors: preflight.errors,
        duration: Date.now() - start,
      },
      warnings: [...carrierNotes, ...preflight.warnings],
      hint:
        "Fix the errors above, then build again. Run extension_manifest_validate for the full report. " +
        "To build anyway (for example to inspect the broken output), pass skipValidation: true.",
    });
  }

  const warnings: string[] = carrierNotes;

  const cliArgs = ["build", args.projectPath, "--browser", browser];
  if (outDir) cliArgs.push("--out-dir", outDir);
  if (args.zip) cliArgs.push("--zip");
  if (args.zipSource) cliArgs.push("--zip-source");
  if (args.zipFilename) cliArgs.push("--zip-filename", args.zipFilename);
  if (args.polyfill) cliArgs.push("--polyfill");
  if (args.silent) cliArgs.push("--silent");
  if (args.mode) cliArgs.push("--mode", args.mode);
  if (safari) cliArgs.push(...safariBuildCliArgs(args, signingTeam.team));
  if (signingTeam.kept) warnings.push(keptTeamNote(signingTeam.team));

  const spawn = { cwd: args.projectPath, timeoutMs: buildBudgetMs(browser) };
  const verdict = await outputJsonVerdict("build", args.projectPath);
  const engineKnownTooOld = verdict.supported === false;
  let attempt = engineKnownTooOld
    ? await runExtensionCli(cliArgs, spawn)
    : await runExtensionCli([...cliArgs, "--output", "json"], spawn);
  const engineRefusedJsonOutput =
    !engineKnownTooOld &&
    attempt.code !== 0 &&
    refusedTheOutputFlag(attempt.stderr ?? "");

  if (engineRefusedJsonOutput) {
    attempt = await runExtensionCli(cliArgs, spawn);
  }

  const { code, stdout, stderr } = attempt;

  if (engineRefusedJsonOutput) {
    warnings.push(
      "The Extension.js installed in this project is older than the one this server expects: it rejected --output json on build, so the build was run a second time without that flag and the result comes from the build summary the engine writes into dist/extension-js/ when this run left one there (a separate warning names the path when it did not). The extension that came out is exactly the same one. Upgrade the project's Extension.js to get the richer report back, including the Safari app identity and the byte totals from the run that just happened, and to stop paying for the second build.",
    );
  } else if (engineKnownTooOld) {
    warnings.push(
      `The Extension.js installed in this project is older than the one this server expects: it reports ${verdict.version}, and --output json only reached extension build in ${verdict.floor}, so the build was run without that flag and the result comes from the build summary the engine writes into dist/extension-js/ when this run left one there (a separate warning names the path when it did not). The extension that came out is exactly the same one, and nothing was built twice. Upgrade the project's Extension.js to get the richer report back, including the Safari app identity and the byte totals from the run that just happened.`,
    );
  }

  const duration = Date.now() - start;
  const engine = readEngineOutput(stdout ?? "", stderr ?? "");
  const out = engine.narration;
  const lastLines = (text: string, n: number): string =>
    text.split("\n").slice(-n).join("\n");

  if (code === 0) {
    const inlineSummary = summaryForBrowser(
      engineSummaries(engine.frame),
      browser,
    );
    const persisted = inlineSummary
      ? null
      : readBuildSummary(args.projectPath, browser, start);
    const engineSummary = inlineSummary ?? persisted?.summary ?? null;
    const summaryPathNote =
      persisted && !persisted.summary
        ? `This build reported no summary of its own, and no summary from this run was found on disk either, so the byte totals and the engine's structured warnings are missing from the result below. The extension that was built is unaffected. ${sessionPathHint(persisted.file)}`
        : null;
    const status = engine.frame?.status;
    const mode = builtMode(engine.frame, out, args.mode);
    const buildWarnings = await channelAwareBuildWarnings(
      engineSummary?.warnings?.length ? engineSummary.warnings : [],
      browser,
      args.projectPath,
    );
    const buildWarningsTruncated =
      buildWarnings.length &&
      typeof engineSummary?.warnings_count === "number" &&
      engineSummary.warnings_count > buildWarnings.length
        ? engineSummary.warnings_count
        : undefined;
    const distRoot = outDir ?? path.join(engineProjectRoot(args.projectPath), "dist");
    const distDir =
      typeof engineSummary?.output_path === "string" && engineSummary.output_path
        ? path.resolve(engineSummary.output_path)
        : path.join(distRoot, engineBrowserName(browser));
    const distManifest = path.join(distDir, "manifest.json");
    let distWrittenAt: number | null = null;

    try {
      distWrittenAt = fs.statSync(distManifest).mtimeMs;
    } catch {
    }

    if (distWrittenAt === null || distWrittenAt < start - 1_000) {
      return envelope({
        ok: false,
        command: COMMAND,
        status: "build-not-found",
        error: {
          code: "E_BUILD_NOT_FOUND",
          message:
            distWrittenAt === null
              ? `The bundler exited 0 but no manifest.json exists at ${distDir}, so nothing was built there.`
              : `The bundler exited 0 but the manifest at ${distDir} predates this build, so this run wrote nothing there.`,
        },
        value: {
          browser,
          buildExitCode: 0,
          distDir,
          duration,
          output: lastLines(out, 12),
        },
        warnings: [...warnings, ...(preflight?.warnings ?? [])],
        hint: `Check the build output above and the project's output configuration: the dist this tool reads is the one the engine reports (output_path), else ${outDir ? "<outDir>/<browser>" : "dist/<browser> under the package root"}.`,
      });
    }

    const manifestEntrypoints = builtEntrypoints(distDir);
    const specialEntrypoints = specialFolderEntrypoints(
      [engineProjectRoot(args.projectPath), args.projectPath],
      distDir,
    );
    const entrypoints = [...manifestEntrypoints, ...specialEntrypoints];
    const specialFolderNote = specialFolderMissingNote(specialEntrypoints, distDir);
    const review = reviewDistReport(distDir, browser);
    const risks = review.risks;
    const contamination = carrierContamination(path.dirname(distDir));
    const uncheckedNote = contamination.unchecked.length
      ? `Could not read the entry table of ${contamination.unchecked.join(", ")}, so those archives were not checked for the live-preview carrier. Unpack and check them yourself before submitting.`
      : null;

    if (contamination.paths.length) {
      return envelope({
        ok: false,
        command: COMMAND,
        status: "carrier-in-dist",
        error: {
          code: "E_CARRIER_IN_DIST",
          message:
            `The build output contains the Extension.dev live-preview carrier: ${contamination.paths.join(", ")}. ` +
            "That is a local debug companion and must never ship. This artifact is not safe to submit.",
        },
        value: {
          browser,
          buildExitCode: 0,
          duration,
        },
        warnings: [...warnings, uncheckedNote],
        hint: "Delete the listed paths from dist and build again. The carrier lives in ./extensions and is taken back before every build run through this tool, so an entry inside a zip means that archive was packed by something else, usually 'extension build --zip-source' driven straight at the engine while a dev session had the carrier in place.",
      });
    }

    const missing = manifestEntrypoints.filter((e) => !e.present);

    if (missing.length) {
      return envelope({
        ok: false,
        command: COMMAND,
        status: "entrypoint-missing",
        error: {
          code: "E_ENTRYPOINT_MISSING",
          message:
            `The build reported success but ${missing.length} declared entrypoint(s) are missing from dist/${browser}: ${ 
            missing.map((m) => `${m.role} -> ${m.path}`).join(", ") 
            }. The browser will refuse to load this build.`,
        },
        value: {
          browser,
          buildExitCode: 0,
          entrypoints,
          duration,
          output: lastLines(out, 12),
        },
        warnings: [
          ...warnings,
          ...(preflight?.warnings ?? []),
          ...buildWarnings,
        ],
        hint: "The bundler exited 0 but did not emit these files. Check that the manifest paths match what the build produces, and that nothing references a file outside the source tree.",
      });
    }

    const zipNotes: string[] = [];
    const zipRootWords = outDir ? path.relative(args.projectPath, outDir) || outDir : "dist";
    const zipPath = args.zip
      ? locateDistZip(args.projectPath, distRoot, browser, args.zipFilename, start, engineSummary)
      : null;

    if (args.zip && !zipPath) {
      zipNotes.push(
        `zip: true was requested and the build succeeded, but the engine's summary names no zip and no .zip newer than this build was found under ${zipRootWords}/ (the engine writes ${zipRootWords}/<name>-<version>-${browser}.zip). Check the build output below.`,
      );
    }

    const zipSourcePath = args.zipSource
      ? locateSourceZip(args.projectPath, distRoot, browser, args.zipFilename, start, engineSummary)
      : null;

    if (args.zipSource && !zipSourcePath) {
      zipNotes.push(
        `zipSource: true was requested and the build succeeded, but the engine's summary names no source zip and no *-source.zip newer than this build was found under ${zipRootWords}/. Check the build output below.`,
      );
    }

    const distFiles = listDistFiles(distDir);
    const droppedPages = droppedRuntimePages(args.projectPath, browser, distDir);
    const duplicates = findDuplicateAssets(distDir, distFiles);
    const largestFiles = largestFilesOf(distFiles, duplicates);
    const largestFilesInline = (largestFiles[0]?.size ?? 0) >= LARGE_ASSET_FLOOR || duplicates.length > 0 ? largestFiles : null;
    const addonLint = addonLintFrame(engineSummary, distRoot, start);
    const toolchain = toolchainValue(engineSummary);

    const divergence = manifestDivergence(args.projectPath, browser);
    const safariIdentity = safari ? (engineSummary?.safari ?? null) : null;
    const derivedBundleIdNote =
      safariIdentity?.bundleIdDerived === true
        ? `The Safari app was packaged under the generated bundle identifier ${safariIdentity.bundleId ?? "the engine derived for you"}, which the engine derived from your app name rather than one you chose. It is fine for running the app locally. Two projects with the same app name derive the same identifier, and Apple binds one permanently to the first team that registers it, so whoever submits first takes it and everyone after is locked out. Rebuild with bundleId set to a reverse-DNS identifier under a domain you own, which regenerates the Xcode project, and do it before your first submission: afterwards a new identifier is a new extension carrying none of your users.`
        : null;
    const safariIdentityMissingNote =
      safari && !safariIdentity
        ? `The build succeeded but reported no Safari app identity, so this run cannot tell you which bundle identifier the app carries. Either the packager did not run (a host that is not macOS skips the local packaging step and leaves a plain bundle in dist/${browser}), or the engine installed in this project predates the reporting contract. No Mac is needed to reach the App Store: the platform's Safari lane packages and signs the build with keys it holds encrypted at rest, after one approval, in the same flow as the other stores, with no hand upload. Check the build output below, and run extension_doctor if you expected an app.`
        : null;

    const signingFrame = safari
      ? await safariSigningFrame(args.projectPath, browser, {
          requested: signingTeam.team,
          appName: safariIdentity?.appName ?? args.appName,
          ...(safariIdentity?.appPath ? { appPath: safariIdentity.appPath } : {}),
          sessionPid: null,
        })
      : null;

    return envelope({
      ok: true,
      command: COMMAND,
      status: "built",
      value: {
        browser,
        mode,
        ...(safariIdentity ? { safariApp: safariIdentity } : {}),
        ...(signingFrame ? { signing: signingFrame.signing } : {}),
        outputPath: distDir,
        ...(typeof engineSummary?.total_bytes === "number"
          ? { totalBytes: engineSummary.total_bytes }
          : {}),
        ...(typeof engineSummary?.total_assets === "number"
          ? { totalAssets: engineSummary.total_assets }
          : {}),
        ...(typeof engineSummary?.largest_asset_bytes === "number"
          ? { largestAssetBytes: engineSummary.largest_asset_bytes }
          : {}),
        ...(status ? { engineBuildStatus: status } : {}),
        ...(largestFilesInline ? { largestFiles: largestFilesInline } : {}),
        ...(duplicates.length ? { duplicateFiles: duplicates } : {}),
        ...(addonLint.value ? { addonLint: addonLint.value } : {}),
        ...(toolchain ? { toolchain } : {}),
        ...(engineRefusedJsonOutput ? { engineRejectedJsonOutput: true } : {}),
        ...(entrypoints.length ? { entrypoints } : {}),
        ...(risks.length ? { reviewRisks: risks } : {}),
        ...(buildWarningsTruncated !== undefined
          ? { buildWarningsTruncated }
          : {}),
        ...(divergence.length ? { productionDivergence: divergence } : {}),
        ...(droppedPages.length ? { droppedRuntimePages: droppedPages } : {}),
        zip: args.zip ?? false,
        ...(zipPath ? { zipPath } : {}),
        ...(zipSourcePath ? { zipSourcePath } : {}),
        duration,
        ...(args.silent ? {} : { output: lastLines(out, 12) }),
      },
      warnings: [
        ...warnings,
        ...(preflight?.warnings ?? []).filter((line) => !isDroppedRuntimePageWarning(line)),
        ...droppedPages.map((page) => page.say),
        ...buildWarnings,
        ...reviewRiskWarnings(risks),
        ...reviewCoverageNotes(review),
        ...zipNotes,
        ...duplicates.map(duplicateAssetSentence),
        ...addonLint.warnings,
        uncheckedNote,
        specialFolderNote,
        derivedBundleIdNote,
        safariIdentityMissingNote,
        summaryPathNote,
        ...(signingFrame?.warnings ?? []),
        ...(signingFrame?.hints ?? []),
      ],
      hint: `The ${mode === "none" ? "" : `${mode} `}build is in ${distDir}.${modeSentence(mode) ? ` ${modeSentence(mode)}` : ""} To read what is in it, call extension_analyze with this projectPath and browser "${browser}": it answers the sizes, the entry points and the store checks a reviewer runs, plus the emitted manifest of every built browser and the resolved keys that differ between them (manifestByBrowser), so there is no need to list or grep the folder by hand or to read dist/<browser>/manifest.json.${zipPath ? ` The store zip is ${zipPath}.` : ""}${platformListed() ? " To send the extension to someone, extension_publish gives the project's build on extension.dev a page with a download and a run command for each browser (the platform builds the source it holds, not this folder: extension_builds action:\"rebuild\" starts that build with no push, and a project built from a repository also builds on a push)." : ""}`,
    });
  }

  if (attempt.timedOut) {
    const words = buildTimeoutWords(browser, spawn.timeoutMs, attempt.signal);

    return envelope({
      ok: false,
      command: COMMAND,
      status: "build-timeout",
      error: { code: "E_BUILD_TIMEOUT", name: "BuildTimeout", message: words.message },
      value: { browser, buildExitCode: null, duration, budgetMs: spawn.timeoutMs, output: lastLines(out, 12) },
      warnings,
      hint: words.hint,
    });
  }

  const engineFailure =
    typeof engine.frame?.error?.message === "string"
      ? engine.frame.error.message.trim()
      : "";
  const message =
    engineFailure ||
    stderr.trim() ||
    out ||
    `extension build exited with code ${code}`;

  if (engine.frame?.error?.code === DEV_SESSION_OWNS_THE_DIST) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "build-refused",
      error: { code: DEV_SESSION_OWNS_THE_DIST, message: message.slice(0, 1200) },
      value: {
        browser,
        duration,
        livePids: liveSameBrowser.map((session) => session.pid),
      },
      warnings,
      hint: `A running dev session serves dist/${browser} and the engine refused to write over it, so nothing was built and the session is untouched. Pass outDir (for example "build", which writes build/${browser}) to build beside it, or call extension_stop with this projectPath and browser "${browser}" and build again.`,
    });
  }

  if (outDir && OUT_DIR_REFUSED.test(stderr) && /unknown option/i.test(stderr)) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "engine-unsupported",
      error: {
        code: "E_ENGINE_TOO_OLD",
        message: `The project's Extension.js engine refused --out-dir, which extension build takes only from ${OUT_DIR_FLOOR} on, so outDir cannot be honored. Nothing was built.`,
      },
      value: { browser, duration },
      warnings,
      hint: `Upgrade the project's engine (npm i -D extension@latest) to build into outDir, or build without outDir after extension_stop on the session that serves dist/${browser}.`,
    });
  }

  const compileErrors = buildCompileErrors(args.projectPath, browser, start);
  const tail = [out, stderr.trim()].filter(Boolean).join("\n").trim();

  return envelope({
    ok: false,
    command: COMMAND,
    status: "build-failed",
    error: { code: "E_BUILD_FAILED", message: message.slice(0, 1200) },
    value: {
      browser,
      duration,
      ...(compileErrors.length ? { errors: compileErrors } : {}),
      ...(tail && !compileErrors.length ? { output: tail.slice(-4000) } : {}),
    },
    warnings,
    hint: compileErrors.length
      ? `Fix the ${compileErrors.length} compile error${compileErrors.length === 1 ? "" : "s"} in value.errors (file, loader and message as the bundler printed them) and build again. extension_manifest_validate covers the manifest; the engine installs dependencies only when none of the declared ones is present, so a missing one beside installed ones is yours to install`
      : "Read value.output for the bundler's own report. The manifest may live at the project root or under src; a failure here is usually a compile error, a manifest the engine refuses, or a Safari toolchain the host does not have.",
  });
}

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function buildCompileErrors(
  projectPath: string,
  browser: string,
  since: number,
): string[] {
  try {
    const file = readyContractPath(projectPath, browser);
    if (fs.statSync(file).mtimeMs < since - COARSE_MTIME_CLOCK_SLACK_MS) return [];

    const contract = JSON.parse(fs.readFileSync(file, "utf8"));
    const errors = Array.isArray(contract?.errors) ? contract.errors : [];

    return errors
      .filter((e: unknown) => typeof e === "string" && e.trim())
      .map((e: string) => e.replace(ANSI_SEQUENCE, "").trim())
      .slice(0, 20);
  } catch {
    return [];
  }
}
