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
import { outputJsonVerdict, refusedTheOutputFlag } from "../lib/engine-version";
import { liveProjectSessions } from "../lib/session-browser";
import { CARRIER_DIR_NAME, removeCarrier } from "../lib/carrier";
import { readZipEntryNames } from "../lib/zip-entries";
import {
  buildSummaryPath,
  readyContractPath,
  sessionPathHint,
  engineProjectRoot,
} from "../lib/session-paths";
import { type Envelope, envelope, isEnvelope } from "../lib/envelope";
import { engineBrowserName } from "../lib/browser-family";
import { reviewCoverageNotes, reviewDistReport, reviewRiskWarnings } from "../lib/store-review";

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
  zip_artifacts?: Array<{ kind?: string; path?: string; size?: number }>;
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
  browser: string,
  zipFilename: string | undefined,
  since: number,
  summary: EngineBuildSummary | null,
): string | null {
  const fromSummary = zipFromSummary(summary, "dist", since);
  if (fromSummary) return fromSummary;

  const distDir = path.resolve(projectPath, "dist", engineBrowserName(browser));
  const distRoot = path.resolve(projectPath, "dist");
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
  browser: string,
  zipFilename: string | undefined,
  since: number,
  summary: EngineBuildSummary | null,
): string | null {
  const fromSummary = zipFromSummary(summary, "source", since);
  if (fromSummary) return fromSummary;

  const distDir = path.resolve(projectPath, "dist", engineBrowserName(browser));
  const distRoot = path.resolve(projectPath, "dist");
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
    "Build a browser extension for production. This tool always passes --browser (chrome unless you set it), so the output lands in dist/<browser>/ (dist/chrome by default) and the answer's outputPath names the folder that was written: read that path instead of assuming one. A scaffolded project's own `npm run build` runs `extension build` with no --browser, which the engine defaults to chromium, so that script writes dist/chromium/ instead. Pass zip:true to also package a .zip for store submission. With browser:'safari' the build converts the extension into a macOS app through Xcode, and bundleId sets the identifier it ships under. The build refuses a manifest with build-blocking errors unless you pass skipValidation:true, because such a manifest yields a broken bundle the bundler itself never flags.",
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
          "Build even when extension_manifest_validate reports build-blocking errors. The build normally refuses: the engine itself stops only on missing scripts, icons, DNR rule files, default_locale and manifest_version, and ships a bundle over the rest.",
      },
      appName: {
        type: "string",
        description:
          "Safari targets only: name of the generated macOS app, which also names the Xcode scheme and the .app on disk. Defaults to the manifest name.",
      },
      bundleId: {
        type: "string",
        description:
          "Safari targets only: a reverse-DNS bundle identifier you own, such as com.acme.readinglist. Without one the app is packaged under a generated dev.extensionjs.* identifier derived from the app name, which two projects with the same name share, and the first team to register it takes it.",
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

export const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;

function manifestDivergence(projectPath: string, browser: string): string[] {
  const read = (p: string): Record<string, any> | null => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };

  const built = read(
    path.resolve(projectPath, "dist", engineBrowserName(browser), "manifest.json"),
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
  appName?: string;
  bundleId?: string;
  macOsOnly?: boolean;
  forceRegenerate?: boolean;
}): Promise<string> {
  const start = Date.now();
  const browser = args.browser ?? "chrome";
  const safari = SAFARI_VENDORS.has(browser);

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
          `bundleId ${JSON.stringify(args.bundleId)} is not an identifier the engine accepts. ` +
          "Expected dot-separated segments of letters, digits and hyphens (the engine's own rule); a reverse-DNS name under a domain you own is what Apple expects at submission.",
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

  const clobberedSessions = liveProjectSessions(args.projectPath).filter(
    (session) => session.browser === browser,
  );
  const warnings: string[] = carrierNotes;
  const clobberNotes: string[] = clobberedSessions.map(
      (session) =>
        `A live dev session (pid ${session.pid}) is running on this project for ${browser}, and this build wrote over its dist/${browser} output. The dev browser may now serve the production artifact instead of the dev build until the next recompile. Run extension_stop, or let dev recompile on the next source change, to resolve it.`,
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
    {cliArgs.push("--macos-only", String(args.macOsOnly));}

  if (args.forceRegenerate) cliArgs.push("--force-regenerate");

  const spawn = { cwd: args.projectPath, timeoutMs: 180_000 };
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
    const buildWarnings = engineSummary?.warnings?.length
      ? engineSummary.warnings
      : [];
    const buildWarningsTruncated =
      buildWarnings.length &&
      typeof engineSummary?.warnings_count === "number" &&
      engineSummary.warnings_count > buildWarnings.length
        ? engineSummary.warnings_count
        : undefined;
    const distDir =
      typeof engineSummary?.output_path === "string" && engineSummary.output_path
        ? path.resolve(engineSummary.output_path)
        : path.join(engineProjectRoot(args.projectPath), "dist", engineBrowserName(browser));
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
        hint: "Check the build output above and the project's output configuration: the dist this tool reads is the one the engine reports (output_path), else dist/<browser> under the package root.",
      });
    }

    const entrypoints = builtEntrypoints(distDir);
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

    const missing = entrypoints.filter((e) => !e.present);

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
    const zipPath = args.zip
      ? locateDistZip(args.projectPath, browser, args.zipFilename, start, engineSummary)
      : null;

    if (args.zip && !zipPath) {
      zipNotes.push(
        `zip: true was requested and the build succeeded, but the engine's summary names no zip and no .zip newer than this build was found under dist/ (the engine writes dist/<name>-<version>-${browser}.zip). Check the build output below.`,
      );
    }

    const zipSourcePath = args.zipSource
      ? locateSourceZip(args.projectPath, browser, args.zipFilename, start, engineSummary)
      : null;

    if (args.zipSource && !zipSourcePath) {
      zipNotes.push(
        `zipSource: true was requested and the build succeeded, but the engine's summary names no source zip and no *-source.zip newer than this build was found under dist/. Check the build output below.`,
      );
    }

    const divergence = manifestDivergence(args.projectPath, browser);
    const safariIdentity = safari ? (engineSummary?.safari ?? null) : null;
    const derivedBundleIdNote =
      safariIdentity?.bundleIdDerived === true
        ? `The Safari app was packaged under the generated bundle identifier ${safariIdentity.bundleId ?? "the engine derived for you"}, which the engine derived from your app name rather than one you chose. It is fine for running the app locally. Two projects with the same app name derive the same identifier, and Apple binds one permanently to the first team that registers it, so whoever submits first takes it and everyone after is locked out. Rebuild with bundleId set to a reverse-DNS identifier under a domain you own, which regenerates the Xcode project, and do it before your first submission: afterwards a new identifier is a new extension carrying none of your users.`
        : null;
    const safariIdentityMissingNote =
      safari && !safariIdentity
        ? `The build succeeded but reported no Safari app identity, so this run cannot tell you which bundle identifier the app carries. Either the packager did not run (a non-macOS host skips packaging and leaves a plain bundle in dist/${browser}), or the engine installed in this project predates the reporting contract. Check the build output below, and run extension_doctor if you expected an app.`
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
        ...(risks.length ? { reviewRisks: risks } : {}),
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
        ...clobberNotes,
        ...(preflight?.warnings ?? []),
        ...buildWarnings,
        ...reviewRiskWarnings(risks),
        ...reviewCoverageNotes(review),
        ...zipNotes,
        uncheckedNote,
        derivedBundleIdNote,
        safariIdentityMissingNote,
        summaryPathNote,
      ],
    });
  }

  if (attempt.timedOut) {
    const budget = spawn.timeoutMs;

    return envelope({
      ok: false,
      command: COMMAND,
      status: "build-timeout",
      error: {
        code: "E_BUILD_TIMEOUT",
        name: "BuildTimeout",
        message: `This server stopped the build after ${budget} ms (${attempt.signal ?? "a signal"}); the engine did not fail, it ran out of the time it was given. A first build that installs dependencies can take longer than that, and the engine process may still be running.`,
      },
      value: { browser, buildExitCode: null, duration, output: lastLines(out, 12) },
      hint: "This tool's budget is fixed at 180 s. Check for a still-running extension build process (it may finish on its own) before retrying; a retry that races it writes the same dist twice.",
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
