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
import { liveProjectSessions } from "../lib/session-browser";
import { CARRIER_DIR_NAME, removeCarrier } from "../lib/carrier";

function readBuildSummary(
  projectPath: string,
  browser: string,
  since: number,
): { warnings?: string[]; warnings_count?: number } | null {
  const file = path.resolve(
    projectPath,
    "dist",
    "extension-js",
    browser,
    "build-summary.json",
  );
  try {
    const stat = fs.statSync(file);
    if (stat.mtimeMs < since) return null;
    const summary = JSON.parse(fs.readFileSync(file, "utf8"));
    if (summary && typeof summary === "object") return summary;
  } catch {
  }
  return null;
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
  if (Array.isArray(bg?.scripts)) bg.scripts.forEach((s) => add("background.scripts", s));
  const action = (manifest.action || manifest.browser_action) as
    | Record<string, unknown>
    | undefined;
  if (action?.default_popup) add("action.default_popup", action.default_popup);
  const pageAction = manifest.page_action as Record<string, unknown> | undefined;
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
        add(`declarative_net_request[${i}].path`, (r as Record<string, unknown>).path);
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
  } catch {
  }
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
    "Build a browser extension for production. The output lands in dist/<browser>/. Pass zip:true to also package a .zip for store submission. The build refuses a manifest with build-blocking errors unless you pass skipValidation:true, because such a manifest yields a broken bundle the bundler itself never flags.",
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
    },
    required: ["projectPath"],
  },
};

function manifestDivergence(
  projectPath: string,
  browser: string,
): string[] {
  const read = (p: string): Record<string, any> | null => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  const built = read(path.resolve(projectPath, "dist", browser, "manifest.json"));
  const source =
    read(path.resolve(projectPath, "src", "manifest.json")) ??
    read(path.resolve(projectPath, "manifest.json"));
  if (!built || !source) return [];

  const notes: string[] = [];
  const listOf = (m: Record<string, any>, key: string): string[] =>
    Array.isArray(m[key]) ? m[key].filter((x: unknown) => typeof x === "string") : [];

  for (const key of ["permissions", "host_permissions", "optional_permissions"]) {
    const lost = listOf(source, key).filter((p) => !listOf(built, key).includes(p));
    if (lost.length) {
      notes.push(
        `The built manifest drops ${key}: ${lost.join(", ")}. The production build has narrower access than the source you tested in dev.`,
      );
    }
  }

  const sourceWar = source.web_accessible_resources;
  const builtWar = built.web_accessible_resources;
  if (Array.isArray(sourceWar) && sourceWar.length && !Array.isArray(builtWar)) {
    notes.push(
      "The built manifest has no web_accessible_resources although the source declares them. Anything injected into a page (scripting.insertCSS targets, injected scripts, images) will be blocked at runtime.",
    );
  }
  return notes;
}

const MARKER_FILE_NAME = "managed-by-extension-dev-mcp.json";

function carrierEntriesInDist(distDir: string, depth = 0): string[] {
  if (depth > 3) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(distDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name === CARRIER_DIR_NAME || entry.name === MARKER_FILE_NAME) {
      found.push(path.join(distDir, entry.name));
      continue;
    }
    if (entry.isDirectory()) {
      found.push(...carrierEntriesInDist(path.join(distDir, entry.name), depth + 1));
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
    return {
      valid: Boolean(parsed.valid),
      buildBlocking: Boolean(parsed.buildBlocking),
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
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
}): Promise<string> {
  const start = Date.now();
  const browser = args.browser ?? "chrome";

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
    return JSON.stringify({
      success: false,
      status: "blocked",
      browser,
      error:
        "Build refused: the manifest has errors that produce a broken extension even when the bundler succeeds.",
      errors: preflight.errors,
      warnings: [...carrierNotes, ...preflight.warnings],
      duration: Date.now() - start,
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

  const { code, stdout, stderr } = await runExtensionCli(cliArgs, {
    cwd: args.projectPath,
    timeoutMs: 180_000,
  });
  const duration = Date.now() - start;
  const out = (stdout ?? "").trim();
  const lastLines = (text: string, n: number): string =>
    text.split("\n").slice(-n).join("\n");

  if (code === 0) {
    const size = out.match(/Size:\s*([\d.]+\s*[kKmMgG]?B)/)?.[1];
    const status = out.match(/Build Status:\s*(\w+)/)?.[1];
    const engineSummary = readBuildSummary(args.projectPath, browser, start);
    const buildWarnings = engineSummary?.warnings?.length
      ? {
          buildWarnings: engineSummary.warnings,
          ...(typeof engineSummary.warnings_count === "number" &&
          engineSummary.warnings_count > engineSummary.warnings.length
            ? { buildWarningsTruncated: engineSummary.warnings_count }
            : {}),
        }
      : {};
    const distDir = path.resolve(args.projectPath, "dist", browser);
    const entrypoints = builtEntrypoints(distDir);
    const contamination = carrierEntriesInDist(distDir);
    if (contamination.length) {
      return JSON.stringify({
        success: false,
        status: "contaminated",
        browser,
        buildExitCode: 0,
        error:
          `The build output contains the Extension.dev live-preview carrier: ${contamination.join(", ")}. ` +
          "That is a local debug companion and must never ship. This artifact is not safe to submit.",
        ...(warnings.length ? { warnings } : {}),
        duration,
        hint: "Delete the listed paths from dist and build again. The carrier normally lives in ./extensions and is removed before every build.",
      });
    }
    const missing = entrypoints.filter((e) => !e.present);
    if (missing.length) {
      return JSON.stringify({
        success: false,
        status: "incomplete",
        browser,
        buildExitCode: 0,
        error:
          `The build reported success but ${missing.length} declared entrypoint(s) are missing from dist/${browser}: ` +
          missing.map((m) => `${m.role} -> ${m.path}`).join(", ") +
          ". The browser will refuse to load this build.",
        entrypoints,
        ...(preflight?.warnings.length
          ? { manifestWarnings: preflight.warnings }
          : {}),
        ...buildWarnings,
        ...(warnings.length ? { warnings } : {}),
        duration,
        output: lastLines(out, 12),
        hint: "The bundler exited 0 but did not emit these files. Check that the manifest paths match what the build produces, and that nothing references a file outside the source tree.",
      });
    }
    return JSON.stringify({
      success: true,
      browser,
      ...(size ? { size } : {}),
      ...(status ? { status } : {}),
      ...(entrypoints.length ? { entrypoints } : {}),
      ...(preflight?.warnings.length
        ? { manifestWarnings: preflight.warnings }
        : {}),
      ...buildWarnings,
      ...(() => {
        const divergence = manifestDivergence(args.projectPath, browser);
        return divergence.length ? { productionDivergence: divergence } : {};
      })(),
      ...(warnings.length ? { warnings } : {}),
      zip: args.zip ?? false,
      ...(args.zip
        ? (() => {
            const zipPath = locateDistZip(
              args.projectPath,
              browser,
              args.zipFilename,
              start,
            );
            return zipPath
              ? { zipPath }
              : {
                  zipPathNote: `zip: true was requested and the build succeeded, but no .zip file could be located in dist/${browser}. The engine may not have packaged it; check the build output below.`,
                };
          })()
        : {}),
      ...(args.zipSource
        ? (() => {
            const zipSourcePath = locateSourceZip(
              args.projectPath,
              browser,
              start,
            );
            return zipSourcePath
              ? { zipSourcePath }
              : {
                  zipSourcePathNote: `zipSource: true was requested and the build succeeded, but no *-source.zip file could be located in dist/. The engine may not have packaged it; check the build output below.`,
                };
          })()
        : {}),
      duration,
      output: lastLines(out, 12),
    });
  }

  const message =
    stderr.trim() || out || `extension build exited with code ${code}`;
  return JSON.stringify({
    success: false,
    browser,
    error: message.slice(0, 1200),
    ...(warnings.length ? { warnings } : {}),
    duration,
    hint: "Check that the project has a valid src/manifest.json and its dependencies are installed (extension_dev auto-installs; build does not).",
  });
}
