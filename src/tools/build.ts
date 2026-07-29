// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { LAUNCH_BROWSER, PROJECT_PATH } from "../lib/common-schema";
import fs from "node:fs";
import path from "node:path";
import { runExtensionCli } from "../lib/exec";
import { outputJsonVerdict, refusedTheOutputFlag } from "../lib/engine-version";
import { liveProjectSessions } from "../lib/session-browser";
import { CARRIER_DIR_NAME, removeCarrier } from "../lib/carrier";
import { readZipEntryNames } from "../lib/zip-entries";
import { buildSummaryPath, sessionPathHint } from "../lib/session-paths";
import { type Envelope, envelope, isEnvelope } from "../lib/envelope";

const COMMAND = "extension_build";

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
}

/* @invariant
 * Two readers for one BuildSummary, because the engine that answers is not
 * the engine this package pins.
 *
 * `extension build --output json` returns the summary inline as
 * value.summaries[], and that is the reading this tool prefers: it belongs to
 * the run that just finished, so no freshness guess is involved. Engines older
 * than the summaries contract answer the same flag with an envelope that has no
 * summaries at all, and those still persist the identical BuildSummary to
 * a build summary on disk. Reading that file second keeps warnings, byte totals
 * and the output path alive against such a project instead of silently
 * reporting a build with no numbers on it. The file is mtime-guarded because it
 * outlives the build that wrote it.
 *
 * Where that file lives is asked of the engine's buildSummaryPath through the
 * one module allowed to know the session layout, never rebuilt from string
 * literals here. The helper describes the layout of the engine this package
 * pins, which against an older project is a claim rather than a fact, and it is
 * still the better of the two options: a literal is wrong in exactly the same
 * case, frozen at whatever the layout was the day someone typed it, and gives a
 * reviewer nothing to notice. What the helper cannot do is make a mismatch
 * visible, and this is the one reader that runs precisely when the engine is
 * already known to disagree with the pin, so a miss carries the absolute path
 * it tried back to the caller instead of reading as an empty answer.
 */
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
    if (stat.mtimeMs >= since) {
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

/* @invariant
 * One retry, and only for the one flag this server adds behind the caller's
 * back.
 *
 * `--output json` reached `extension build` in 4.0.17. A project pinned to
 * anything older has working builds today, and commander answers an
 * unrecognised flag by writing one line to stderr and exiting 1 before any
 * compile starts. Sending the flag unconditionally would therefore turn every
 * build in such a project into E_BUILD_FAILED carrying an error about a flag
 * the user never typed, which is breaking a working build to delete a regex.
 *
 * So the refusal is detected and the build is run once more without the flag,
 * where the persisted build summary still answers everything the envelope
 * would have. The match is deliberately narrow: it needs a non-zero exit AND
 * the engine's unknown-option line, in either of the two phrasings the
 * detector pins, AND that line to name --output. A real compile failure exits
 * non-zero without ever printing that, so it is reported as the failure it is
 * rather than being retried. There is no loop: the second run omits the only
 * flag that can produce this line, so its result is final whatever it says.
 *
 * The scope is the point. --macos-only is just as new, and it is NOT retried
 * away, because the caller asked for it: dropping it would build a macOS-only
 * project for someone who asked for a universal one and call that success.
 * A flag the caller chose fails loudly; a flag this server chose gets a second
 * chance without it.
 *
 * The version probe in front of this retry means it should almost never fire,
 * because an engine known to be below the floor is simply not sent the flag.
 * The retry stays anyway, and stays load-bearing: the probe answers "unknown"
 * whenever the version cannot be read or parsed, and an engine could in
 * principle report a version whose flag support does not match what the tag
 * history says. The probe removes a cost; only this retry removes a failure.
 *
 * The detector itself lives in lib/engine-version next to the floor table,
 * because doctor and the act family meet the same refusal and must explain it
 * against the same numbers. Only build can answer it by retrying.
 */

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
    bg.scripts.forEach((s) => add("background.scripts", s));
  const action = (manifest.action || manifest.browser_action) as
    | Record<string, unknown>
    | undefined;
  if (action?.default_popup) add("action.default_popup", action.default_popup);
  const pageAction = manifest.page_action as
    | Record<string, unknown>
    | undefined;
  if (pageAction?.default_popup)
    add("page_action.default_popup", pageAction.default_popup);
  const cs = manifest.content_scripts as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(cs)) {
    cs.forEach((c, i) => {
      if (Array.isArray(c.js))
        c.js.forEach((j) => add(`content_scripts[${i}].js`, j));
      if (Array.isArray(c.css))
        c.css.forEach((s) => add(`content_scripts[${i}].css`, s));
    });
  }
  add("devtools_page", manifest.devtools_page);
  add("options_page", manifest.options_page);
  const optionsUi = manifest.options_ui as Record<string, unknown> | undefined;
  if (optionsUi?.page) add("options_ui.page", optionsUi.page);
  const sidePanel = manifest.side_panel as Record<string, unknown> | undefined;
  if (sidePanel?.default_path)
    add("side_panel.default_path", sidePanel.default_path);
  const sidebarAction = manifest.sidebar_action as
    | Record<string, unknown>
    | undefined;
  if (sidebarAction?.default_panel)
    add("sidebar_action.default_panel", sidebarAction.default_panel);
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
      .filter((entry) => entry.mtimeMs >= since)
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

function locateDistZip(
  projectPath: string,
  browser: string,
  zipFilename: string | undefined,
  since: number,
): string | null {
  const distDir = path.resolve(projectPath, "dist", browser);
  const base = zipFilename
    ? engineSanitize(zipFilename)
    : engineZipBase(distDir, projectPath);
  const expected = path.join(distDir, `${base}.zip`);
  if (fs.existsSync(expected)) return expected;
  return newestZip(distDir, since);
}

function locateSourceZip(
  projectPath: string,
  browser: string,
  since: number,
): string | null {
  const distDir = path.resolve(projectPath, "dist", browser);
  const distRoot = path.resolve(projectPath, "dist");
  const expected = path.join(
    distRoot,
    `${engineZipBase(distDir, projectPath)}-source.zip`,
  );
  if (fs.existsSync(expected)) return expected;
  return newestZip(distRoot, since, (name) => name.endsWith("-source.zip"));
}

export const schema = {
  name: "extension_build",
  description:
    "Build a browser extension for production. The output lands in dist/<browser>/. Pass zip:true to also package a .zip for store submission. With browser:'safari' the build converts the extension into a macOS app through Xcode, and bundleId sets the identifier it ships under. The build refuses a manifest with build-blocking errors unless you pass skipValidation:true, because such a manifest yields a broken bundle the bundler itself never flags.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: PROJECT_PATH,
      browser: LAUNCH_BROWSER,
      zip: {
        type: "boolean",
        default: false,
        description: "Create a .zip file for store distribution",
      },
      zipSource: {
        type: "boolean",
        default: false,
        description: "Include source code zip (required by some stores)",
      },
      zipFilename: {
        type: "string",
        description: "Custom .zip file name (defaults to name and version)",
      },
      polyfill: {
        type: "boolean",
        default: false,
        description: "Apply cross-browser polyfill",
      },
      silent: {
        type: "boolean",
        default: false,
        description: "Suppress build output",
      },
      mode: {
        type: "string",
        enum: ["development", "production", "none"],
        default: "production",
        description: "Bundler mode override (also sets NODE_ENV)",
      },
      skipValidation: {
        type: "boolean",
        default: false,
        description:
          "Build even when extension_manifest_validate reports build-blocking errors. The build normally refuses: a manifest error yields a broken bundle the bundler itself never flags.",
      },
      appName: {
        type: "string",
        description:
          "Safari targets only: name of the generated macOS app, which also names the Xcode scheme and the .app on disk. Defaults to the manifest name.",
      },
      bundleId: {
        type: "string",
        description:
          "Safari targets only: a reverse-DNS bundle identifier you own, such as com.acme.readinglist. Without one the app is packaged under a generated dev.extensionjs.* identifier derived from the app name, which every project built from the same template shares, and the first team to register it takes it.",
      },
      macOsOnly: {
        type: "boolean",
        default: true,
        description:
          "Safari targets only: generate a macOS-only Xcode project. Pass false for a universal project that also targets iOS and iPadOS, which is what you want if the extension ships on iPhone or iPad.",
      },
      forceRegenerate: {
        type: "boolean",
        default: false,
        description:
          "Safari targets only: regenerate the Xcode project even when the engine considers it up to date. Use it when an earlier packaging run left the project broken.",
      },
    },
    required: ["projectPath"],
  },
};

const SAFARI_VENDORS = new Set(["safari", "webkit-based"]);

/* @invariant
 * The bundle identifier is checked here as well as in the engine, on purpose.
 *
 * `extension build` rejects a malformed --bundle-id by writing one line to
 * stderr and exiting 1, which reaches an agent as a generic E_BUILD_FAILED
 * after a full compile has already been paid for. Checking the same shape
 * before the spawn turns a wasted build into a named refusal the model can act
 * on. The pattern is Apple's: dot-separated segments of letters, digits and
 * hyphens, each beginning with a letter, at least two of them.
 *
 * The engine now exports the same check as isValidBundleId, from `extension`'s
 * ./browsers subpath rather than its root entry, and this copy stays anyway.
 * Importing it would make the CLI package a
 * dependency of this one, and the whole point of resolveExtensionInvocation is
 * that this server drives whichever engine the user's project has installed
 * rather than one it bundles; a pinned second engine in the tree would be a
 * copy that validates nothing anybody runs. One regex is the cheaper duplicate.
 * It is duplicated rather than drifted: loosening this copy would only move the
 * rejection back to where it is expensive, never accept more. The parity test
 * in build-safari-packaging pins the pattern to the engine's own literal.
 */
export const BUNDLE_ID_PATTERN =
  /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;

function manifestDivergence(projectPath: string, browser: string): string[] {
  const read = (p: string): Record<string, any> | null => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  const built = read(
    path.resolve(projectPath, "dist", browser, "manifest.json"),
  );
  const source =
    read(path.resolve(projectPath, "src", "manifest.json")) ??
    read(path.resolve(projectPath, "manifest.json"));
  if (!built || !source) return [];

  const notes: string[] = [];
  const listOf = (m: Record<string, any>, key: string): string[] =>
    Array.isArray(m[key])
      ? m[key].filter((x: unknown) => typeof x === "string")
      : [];

  for (const key of [
    "permissions",
    "host_permissions",
    "optional_permissions",
  ]) {
    const lost = listOf(source, key).filter(
      (p) => !listOf(built, key).includes(p),
    );
    if (lost.length) {
      notes.push(
        `The built manifest drops ${key}: ${lost.join(", ")}. The production build has narrower access than the source you tested in dev.`,
      );
    }
  }

  const sourceWar = source.web_accessible_resources;
  const builtWar = built.web_accessible_resources;
  if (
    Array.isArray(sourceWar) &&
    sourceWar.length &&
    !Array.isArray(builtWar)
  ) {
    notes.push(
      "The built manifest has no web_accessible_resources although the source declares them. Anything injected into a page (scripting.insertCSS targets, injected scripts, images) will be blocked at runtime.",
    );
  }
  return notes;
}

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

/* @invariant
 * The guard looks at the whole of dist, and inside the archives it holds.
 *
 * It used to walk dist/<browser> only, and only from inside extension_build,
 * which removes the carrier before it runs the engine. The leak it therefore
 * could not see is `extension build --zip-source` driven straight at the
 * engine: that packs the project's own tree, ./extensions and all, so the
 * carrier ends up inside a source zip at the root of dist rather than loose in
 * the browser output. A carrier a reviewer can unzip out of a submission is
 * exactly the thing this must never let past, so both the loose walk and the
 * archives are checked, and a zip whose entry table cannot be read is reported
 * as unchecked rather than silently passed.
 */
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

async function validationPreflight(
  projectPath: string,
  browser: string,
): Promise<ValidationPreflight | null> {
  try {
    const manifestValidate = await import("./manifest-validate");
    const parsed = JSON.parse(
      await manifestValidate.handler({ projectPath, browsers: [browser] }),
    );
    const value = parsed?.value ?? {};
    return {
      valid: Boolean(value.valid),
      buildBlocking: Boolean(value.buildBlocking),
      errors: Array.isArray(value.errors) ? value.errors : [],
      warnings: Array.isArray(value.warnings) ? value.warnings : [],
    };
  } catch {
    return null;
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
  appName?: string;
  bundleId?: string;
  macOsOnly?: boolean;
  forceRegenerate?: boolean;
}): Promise<string> {
  const start = Date.now();
  const browser = args.browser ?? "chrome";
  const safari = SAFARI_VENDORS.has(browser);

  /* @invariant
   * macOsOnly is listed raw while forceRegenerate is normalised to undefined
   * when false, because the two flags carry different amounts of meaning.
   * forceRegenerate: false is the default and asks for nothing, so refusing a
   * chrome build over it would be refusing an empty request. macOsOnly: false
   * is the caller asking for a universal macOS and iOS Xcode project, a real
   * instruction this tool cannot honour for chrome, so it has to be refused
   * rather than dropped. A truthy filter here would drop exactly that value and
   * silently build for chrome instead; the engine shipped that bug on its own
   * --macos-only and fixed it by testing for undefined, which is what the
   * filter below does.
   */
  const safariOnly = (
    [
      ["appName", args.appName],
      ["bundleId", args.bundleId],
      ["macOsOnly", args.macOsOnly],
      ["forceRegenerate", args.forceRegenerate === true ? true : undefined],
    ] as Array<[string, unknown]>
  )
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);

  if (safariOnly.length > 0 && !safari) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "safari-only-option",
      error: {
        code: "E_SAFARI_ONLY_OPTION",
        message:
          `${safariOnly.join(", ")} configure the Safari web-extension conversion and mean nothing for a ${browser} build. ` +
          "Nothing was built, so the options were not silently ignored.",
      },
      value: { browser, options: safariOnly, duration: Date.now() - start },
      hint:
        'Pass browser: "safari" to package a Safari app, or drop these options to build for ' +
        `${browser}.`,
    });
  }

  if (args.bundleId !== undefined && !BUNDLE_ID_PATTERN.test(args.bundleId)) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "invalid-bundle-id",
      error: {
        code: "E_INVALID_BUNDLE_ID",
        message:
          `bundleId ${JSON.stringify(args.bundleId)} is not a reverse-DNS identifier, so Xcode would reject it. ` +
          "Expected two or more dot-separated segments of letters, digits and hyphens, each starting with a letter.",
      },
      value: { browser, bundleId: args.bundleId, duration: Date.now() - start },
      hint: 'Use an identifier under a domain you own, for example "com.acme.readinglist".',
    });
  }

  const carrierCleanup = removeCarrier(args.projectPath);
  const carrierNotes: string[] = [];
  if (carrierCleanup.removed) {
    carrierNotes.push(
      "Removed the Extension.dev live-preview carrier from ./extensions before building. It is a debug companion, not part of your extension; run extension_dev with carrier: true to get it back.",
    );
  } else if (carrierCleanup.note) {
    carrierNotes.push(carrierCleanup.note);
  }

  const preflight = args.skipValidation
    ? null
    : await validationPreflight(args.projectPath, browser);
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

  const clobberedSessions = liveProjectSessions(args.projectPath).filter(
    (session) => session.browser === browser,
  );
  const warnings: string[] = carrierNotes.concat(
    clobberedSessions.map(
      (session) =>
        `A live dev session (pid ${session.pid}) is running on this project for ${browser}, and this build wrote over its dist/${browser} output. The dev browser may now serve the production artifact instead of the dev build until the next recompile. Run extension_stop, or let dev recompile on the next source change, to resolve it.`,
    ),
  );

  const cliArgs = ["build", args.projectPath, "--browser", browser];
  if (args.zip) cliArgs.push("--zip");
  if (args.zipSource) cliArgs.push("--zip-source");
  if (args.zipFilename) cliArgs.push("--zip-filename", args.zipFilename);
  if (args.polyfill) cliArgs.push("--polyfill");
  if (args.silent) cliArgs.push("--silent");
  if (args.mode) cliArgs.push("--mode", args.mode);
  if (args.appName) cliArgs.push("--app-name", args.appName);
  if (args.bundleId) cliArgs.push("--bundle-id", args.bundleId);
  if (args.macOsOnly !== undefined)
    cliArgs.push("--macos-only", String(args.macOsOnly));
  if (args.forceRegenerate) cliArgs.push("--force-regenerate");

  const spawn = { cwd: args.projectPath, timeoutMs: 180_000 };
  /* @invariant
   * Decide the version before spending a compile, not after.
   *
   * Discovering the engine is too old by watching it refuse the flag costs a
   * whole second build, and a build is the most expensive thing this server
   * does. Asking the resolved binary its version first costs one non-compiling
   * exec, cached for a minute, which is nothing beside the compile it saves.
   * Only a definite "too old" changes behaviour: an unknown verdict sends the
   * flag exactly as before, so a probe that fails costs the optimisation and
   * never the build.
   */
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
      "The Extension.js installed in this project is older than the one this server expects: it rejected --output json on build, so the build was run a second time without that flag and the result was read from the build summary the engine writes into dist/extension-js/. The extension that came out is exactly the same one. Upgrade the project's Extension.js to get the richer report back, including the Safari app identity and the byte totals from the run that just happened, and to stop paying for the second build.",
    );
  } else if (engineKnownTooOld) {
    /* @invariant
     * The same warning, minus the claim that is no longer true.
     *
     * Both paths land on an engine below the floor and both read the result off
     * the persisted summary, so both must tell the user to upgrade. What the
     * probe path must not say is that a second build was paid for, because the
     * probe is precisely what stopped that from happening. Repeating the retry
     * wording here would teach the user to expect a cost this code just removed.
     */
    warnings.push(
      `The Extension.js installed in this project is older than the one this server expects: it reports ${verdict.version}, and --output json only reached extension build in ${verdict.floor}, so the build was run without that flag and the result was read from the build summary the engine writes into dist/extension-js/. The extension that came out is exactly the same one, and nothing was built twice. Upgrade the project's Extension.js to get the richer report back, including the Safari app identity and the byte totals from the run that just happened.`,
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
    /* @invariant
     * A fallback that finds nothing says where it looked.
     *
     * The disk read only happens when the engine reported no summary inline,
     * which already means the engine disagrees with the version this package
     * pins. The path it reads comes from the pinned engine's layout helper, so
     * an older project whose layout differs is exactly the case where the file
     * is not there. Reporting no numbers without naming the path reads as "the
     * build produced nothing", which sends the reader off to inspect a build
     * that is in fact fine, so the path is stated and the note says plainly
     * that the extension is unaffected.
     */
    const summaryPathNote =
      persisted && !persisted.summary
        ? `This build reported no summary of its own, and no summary from this run was found on disk either, so the byte totals and the engine's structured warnings are missing from the result below. The extension that was built is unaffected. ${sessionPathHint(persisted.file)}`
        : null;
    const status = engine.frame?.status;
    const buildWarnings = engineSummary?.warnings?.length
      ? engineSummary.warnings
      : [];
    const buildWarningsTruncated =
      buildWarnings.length &&
      typeof engineSummary?.warnings_count === "number" &&
      engineSummary.warnings_count > buildWarnings.length
        ? engineSummary.warnings_count
        : undefined;
    const distDir = path.resolve(args.projectPath, "dist", browser);
    const entrypoints = builtEntrypoints(distDir);
    const contamination = carrierContamination(
      path.resolve(args.projectPath, "dist"),
    );
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
    const missing = entrypoints.filter((e) => !e.present);
    if (missing.length) {
      return envelope({
        ok: false,
        command: COMMAND,
        status: "entrypoint-missing",
        error: {
          code: "E_ENTRYPOINT_MISSING",
          message:
            `The build reported success but ${missing.length} declared entrypoint(s) are missing from dist/${browser}: ` +
            missing.map((m) => `${m.role} -> ${m.path}`).join(", ") +
            ". The browser will refuse to load this build.",
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
    const zipPath = args.zip
      ? locateDistZip(args.projectPath, browser, args.zipFilename, start)
      : null;
    if (args.zip && !zipPath) {
      zipNotes.push(
        `zip: true was requested and the build succeeded, but no .zip file could be located in dist/${browser}. The engine may not have packaged it; check the build output below.`,
      );
    }
    const zipSourcePath = args.zipSource
      ? locateSourceZip(args.projectPath, browser, start)
      : null;
    if (args.zipSource && !zipSourcePath) {
      zipNotes.push(
        `zipSource: true was requested and the build succeeded, but no *-source.zip file could be located in dist/. The engine may not have packaged it; check the build output below.`,
      );
    }
    const divergence = manifestDivergence(args.projectPath, browser);
    /* @invariant
     * A Safari build reports the identity the packager says it produced, and
     * the derived-identifier warning is driven by bundleIdDerived rather than by
     * the shape of the identifier.
     *
     * The identifier can come from three places, in this order: the bundleId
     * option, `browser.safari.bundleId` in the project config, and finally an
     * identifier the engine derives from the app name. Only the packager knows
     * which of the three it used. Matching a `dev.extensionjs.` prefix instead
     * would get the answer right today and wrong twice over: a developer who
     * legitimately owns that namespace would be warned about their own id, and
     * the day the engine derives under a different prefix the warning goes
     * quiet.
     *
     * What the cost actually is: Apple does NOT verify who owns the domain in a
     * bundle id, so a foreign namespace is not rejected for being foreign. It
     * binds an identifier permanently to the FIRST team that registers it, and
     * a derived id is shared by every project built from the same template, so
     * the real risk is a collision that locks out everyone after the first.
     * Two pairs in the shipped template corpus already derive one id. The
     * identity is baked into the project fingerprint, so discovering it at
     * submission time means regenerating the project.
     */
    const safariIdentity = safari ? (engineSummary?.safari ?? null) : null;
    const derivedBundleIdNote =
      safariIdentity?.bundleIdDerived === true
        ? `The Safari app was packaged under the generated bundle identifier ${safariIdentity.bundleId ?? "the engine derived for you"}, which the engine derived from your app name rather than one you chose. It is fine for running the app locally. Every project built from the same template derives the same identifier, and Apple binds one permanently to the first team that registers it, so whoever submits first takes it and everyone after is locked out. Rebuild with bundleId set to a reverse-DNS identifier under a domain you own, which regenerates the Xcode project, and do it before your first submission: afterwards a new identifier is a new extension carrying none of your users.`
        : null;
    const safariIdentityMissingNote =
      safari && !safariIdentity
        ? `The build succeeded but reported no Safari app identity, so this run cannot tell you which bundle identifier the app carries. Either the packager did not run (a non-macOS host, or Xcode missing, skips packaging and leaves a plain bundle in dist/${browser}), or the engine installed in this project predates the reporting contract. Check the build output below, and run extension_doctor if you expected an app.`
        : null;
    return envelope({
      ok: true,
      command: COMMAND,
      status: "built",
      value: {
        browser,
        ...(safariIdentity ? { safariApp: safariIdentity } : {}),
        ...(typeof engineSummary?.output_path === "string"
          ? { outputPath: engineSummary.output_path }
          : {}),
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
        ...(engineRefusedJsonOutput ? { engineRejectedJsonOutput: true } : {}),
        ...(entrypoints.length ? { entrypoints } : {}),
        ...(buildWarningsTruncated !== undefined
          ? { buildWarningsTruncated }
          : {}),
        ...(divergence.length ? { productionDivergence: divergence } : {}),
        zip: args.zip ?? false,
        ...(zipPath ? { zipPath } : {}),
        ...(zipSourcePath ? { zipSourcePath } : {}),
        duration,
        output: lastLines(out, 12),
      },
      warnings: [
        ...warnings,
        ...(preflight?.warnings ?? []),
        ...buildWarnings,
        ...zipNotes,
        uncheckedNote,
        derivedBundleIdNote,
        safariIdentityMissingNote,
        summaryPathNote,
      ],
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
  return envelope({
    ok: false,
    command: COMMAND,
    status: "build-failed",
    error: { code: "E_BUILD_FAILED", message: message.slice(0, 1200) },
    value: { browser, duration },
    warnings,
    hint: "Check that the project has a valid src/manifest.json. Missing dependencies are installed by the build itself, so a failure here is usually the manifest, a compile error, or a Safari toolchain the host does not have.",
  });
}
