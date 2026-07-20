// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { runExtensionCli } from "../lib/exec";

// Enumerate declared entrypoints from the built manifest so a content-script (or
// any small entry) is not read as "didn't build" when the CLI's own summary tree
// omits it. Mirrors extension_inspect's entrypoints list.
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
  if (Array.isArray(bg?.scripts)) bg.scripts.forEach((s) => add("background.scripts", s));
  const action = (manifest.action || manifest.browser_action) as
    | Record<string, unknown>
    | undefined;
  if (action?.default_popup) add("action.default_popup", action.default_popup);
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
  return out;
}

export const schema = {
  name: "extension_build",
  description:
    "Build a browser extension for production. Outputs to dist/<browser>/. Optionally creates .zip for store submission.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root",
      },
      browser: {
        type: "string",
        enum: ["chrome", "chromium", "edge", "brave", "opera", "vivaldi", "yandex", "firefox", "waterfox", "librewolf", "safari", "chromium-based", "gecko-based", "firefox-based", "webkit-based"],
        default: "chrome",
        description: "Target browser",
      },
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
          "Build even when extension_manifest_validate reports build-blocking errors. The build normally refuses, because a manifest error means the bundle it produces is broken in ways the bundler itself does not report.",
      },
    },
    required: ["projectPath"],
  },
};

interface ValidationPreflight {
  valid: boolean;
  buildBlocking: boolean;
  errors: string[];
  warnings: string[];
}

// The bundler happily emits a bundle for a manifest that names files it does not
// have, or calls a chrome.* API it never asked permission for: the build goes
// green and the extension breaks at runtime. Personas repeatedly shipped a
// broken build off a green `build`, so build now runs the same static checks
// extension_manifest_validate does and refuses when they are build-blocking.
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
    // Never let the preflight itself block a build that would otherwise work.
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
      warnings: preflight.warnings,
      duration: Date.now() - start,
      hint:
        "Fix the errors above, then build again. Run extension_manifest_validate for the full report. " +
        "To build anyway (for example to inspect the broken output), pass skipValidation: true.",
    });
  }

  // Shell out to the project's own extension CLI (project-local bin when
  // present, else the pinned npx fallback) exactly like dev/start/preview.
  // Running the build in-process against THIS package's extension-develop made
  // build the odd tool out: it used a different toolchain than the rest of the
  // session and inherited the MCP's dependency tree (an rspack core/binding
  // skew here broke it). Shelling out keeps build consistent with dev/preview
  // and uses the project's matching dependencies.
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
    const entrypoints = builtEntrypoints(
      path.resolve(args.projectPath, "dist", browser),
    );
    // A zero exit code is the BUNDLER's verdict, not the artifact's. If the
    // built manifest declares a file the dist does not contain, Chrome refuses
    // to load the extension — so reporting success:true here would be the same
    // "it built, so it works" lie the manifest gate exists to prevent. We
    // already computed `present` per entrypoint; act on it.
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
      // A green build with a dangling path reference is the exact shape of the
      // "it built, so it works" trap; carry the non-blocking findings out.
      ...(preflight?.warnings.length
        ? { manifestWarnings: preflight.warnings }
        : {}),
      zip: args.zip ?? false,
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
    duration,
    hint: "Check that the project has a valid src/manifest.json and its dependencies are installed (extension_dev auto-installs; build does not).",
  });
}
