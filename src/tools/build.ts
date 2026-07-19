// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { runExtensionCli } from "../lib/exec";

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
    },
    required: ["projectPath"],
  },
};

export async function handler(args: {
  projectPath: string;
  browser?: string;
  zip?: boolean;
  zipSource?: boolean;
  zipFilename?: string;
  polyfill?: boolean;
  silent?: boolean;
  mode?: "development" | "production" | "none";
}): Promise<string> {
  const start = Date.now();
  const browser = args.browser ?? "chrome";

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
    return JSON.stringify({
      success: true,
      browser,
      ...(size ? { size } : {}),
      ...(status ? { status } : {}),
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
