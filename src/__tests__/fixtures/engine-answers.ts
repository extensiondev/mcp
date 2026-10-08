
import fs from "node:fs";
import path from "node:path";

import { engineProjectRoot } from "../../lib/session-paths";

type Body = Record<string, unknown>;

export function writeEngineDist(projectPath: string, browser: string): string {
  const distDir = path.join(projectPath, "dist", browser);
  const manifest = path.join(distDir, "manifest.json");
  if (fs.existsSync(manifest)) {
    const now = new Date();
    fs.utimesSync(manifest, now, now);
    return distDir;
  }
  const src = fs.existsSync(path.join(projectPath, "src", "manifest.json"))
    ? path.join(projectPath, "src")
    : projectPath;
  fs.mkdirSync(distDir, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    fs.cpSync(path.join(src, entry.name), path.join(distDir, entry.name), { recursive: true });
  }
  return distDir;
}

export function browserFromCliArgs(args: string[]): string {
  const at = args.indexOf("--browser");
  return at >= 0 && args[at + 1] ? String(args[at + 1]) : "chrome";
}

const NOW = "2026-10-05T12:00:00.000Z";

export function readyContract(
  command: "dev" | "start" | "preview" | "build",
  browser: string,
  overrides: Body = {},
): Body {
  const distPath = `/tmp/project/dist/${browser}`;
  const base: Body = {
    schemaVersion: 2,
    schema: 1,
    command,
    browser,
    runId: `run-${command}`,
    startedAt: NOW,
    distPath,
    manifestPath: "/tmp/project/src/manifest.json",
    port: command === "dev" ? 8080 : null,
    ...(command === "build" ? {} : { host: "localhost" }),
    controlPort: command === "dev" ? 43210 : null,
    toolchainVersion: "4.1.32",
    extensionName: "Fixture",
    extensionVersion: "1.0.0",
    status: "ready",
    pid: process.pid,
    ts: NOW,
    compiledAt: NOW,
    errors: [],
    extensionId: "kgdaecdpfkikjncaalnmmnjjfpofkcbl",
  };
  if (command === "dev") {
    Object.assign(base, {
      instanceId: "inst-fixture",
      controlPath: "/__extension_js_control",
      logsPath: `/tmp/project/dist/extension-js/${browser}/logs.ndjson`,
    });
  }
  return { ...base, ...overrides };
}

export function safariDevContract(
  session: { port: number; sessionId: string } | { unavailableReason: string },
  overrides: Body = {},
): Body {
  const stamp =
    "unavailableReason" in session
      ? { webdriverUnavailableReason: session.unavailableReason }
      : { webdriverPort: session.port, webdriverSessionId: session.sessionId };
  return readyContract("dev", "safari", { ...stamp, ...overrides });
}

export function attachedDevContract(browser: string, overrides: Body = {}): Body {
  return readyContract("dev", browser, {
    cdpPort: 9333,
    browserPid: process.pid,
    launcherPid: process.pid,
    profilePath: `/tmp/project/dist/extension-js/profiles/${browser}-profile`,
    binary: `/Applications/${browser}`,
    binaryProvenance: "managed",
    executorAttachedAt: NOW,
    runtime: "attached",
    ...overrides,
  });
}


export function errorContract(
  browser: string,
  code:
    | "compile_error"
    | "browser_exited"
    | "browser_launch_failed"
    | "extension_load_refused"
    | "dev_server_start_failed",
  overrides: Body = {},
): Body {
  const messages: Record<string, string> = {
    compile_error: "Compilation failed",
    browser_exited: "the browser exited",
    browser_launch_failed: "the browser process could not start",
    extension_load_refused: "the browser refused to load the extension",
    dev_server_start_failed: "the dev server could not start",
  };
  return readyContract("dev", browser, {
    status: "error",
    code,
    message: messages[code],
    compiledAt: code === "compile_error" ? null : NOW,
    errors: code === "compile_error" ? ["Module not found: ./missing"] : [],
    ...overrides,
  });
}

export function logHeader(runId: string, rotatedFrom: string | null = null): Body {
  return { v: 1, type: "header", runId, startedAt: NOW, rotatedFrom };
}

export function logEvent(
  context: string,
  level: "log" | "info" | "warn" | "error" | "debug" | "trace",
  parts: unknown[],
  overrides: Body = {},
): Body {
  return {
    v: 1,
    id: `evt-${Math.random().toString(16).slice(2, 10)}`,
    timestamp: Date.parse(NOW),
    level,
    context,
    messageParts: parts,
    runId: "run-dev",
    seq: 1,
    ...overrides,
  };
}

export function logGap(dropped: number): Body {
  return { v: 1, type: "gap", reason: "disk_slow", dropped };
}

export function logFile(runId: string, events: Body[], rotatedFrom: string | null = null): string {
  return [logHeader(runId, rotatedFrom), ...events]
    .map((line) => JSON.stringify(line))
    .join("\n")
    .concat("\n");
}

export function actFrame(command: string, value: unknown, overrides: Body = {}): Body {
  return {
    type: "result",
    cmdId: `c-${process.pid}-1`,
    schema: 1,
    ok: true,
    command,
    status: "ok",
    value,
    error: null,
    warnings: [],
    ...overrides,
  };
}

export function actFailure(
  command: string,
  error: { name: string; message: string; code: string; hint?: string; engine?: string },
  status: "failed" | "not-found" | "denied" | "timeout" | "usage" = "failed",
): Body {
  return {
    type: "result",
    cmdId: `c-${process.pid}-1`,
    schema: 1,
    ok: false,
    command,
    status,
    value: null,
    error: { engine: "chromium", ...error },
    warnings: [],
  };
}

export function cliRefusal(command: string, code: string, message: string, hint?: string): Body {
  return {
    schema: 1,
    ok: false,
    command,
    status: "failed",
    value: null,
    error: { code, message, name: "CliError", ...(hint ? { hint } : {}) },
    warnings: [],
  };
}

export function tabRows(
  rows: Array<{ id: number; url: string; title?: string; active?: boolean; windowId?: number }>,
): Array<{ id: number; url: string; title: string; active: boolean; windowId: number }> {
  return rows.map((row, index) => ({
    id: row.id,
    url: row.url,
    title: row.title ?? "",
    active: row.active ?? index === 0,
    windowId: row.windowId ?? 1,
  }));
}

export function buildSummary(
  browser: string,
  overrides: Body = {},
): Body {
  return {
    browser,
    output_path: `/tmp/project/dist/${browser}`,
    total_assets: 4,
    total_bytes: 12_288,
    largest_asset_bytes: 8_192,
    warnings_count: 0,
    errors_count: 0,
    addon_lint: { status: "skipped", reason: "browser" },
    ...overrides,
  };
}

export function buildFrame(
  projectPath: string,
  browsers: string[],
  overrides: Body = {},
): Body {
  return {
    schema: 1,
    ok: true,
    command: "build",
    status: "built",
    value: {
      projectPath,
      browsers,
      mode: "production",
      summaries: browsers.map((browser) =>
        buildSummary(browser, {
          output_path: path.join(engineProjectRoot(projectPath), "dist", browser),
        }),
      ),
    },
    error: null,
    warnings: [],
    ...overrides,
  };
}

export function preSummariesBuildFrame(projectPath: string, browsers: string[]): Body {
  const frame = buildFrame(projectPath, browsers);
  const { summaries: _dropped, ...value } = frame.value as Body;
  return { ...frame, value };
}

export function buildNarration(
  browser: string,
  name = "Fixture",
  version = "1.0.0",
  bytes = 165,
): string {
  const label = browser.charAt(0).toUpperCase() + browser.slice(1);
  return [
    `⏵⏵⏵ [12:00:00] ${name} compiled in 212 ms.`,
    " ",
    " 🧩 Extension.js 4.1.32",
    `    Browser        ${label}`,
    `    Extension      ${name} ${version}`,
    `    Output         /tmp/project/dist/${browser}`,
    " ",
    ".",
    "└─ manifest.json (0.14KB)",
    "",
    `⏵⏵⏵ Extension built for production in dist/${browser} (${bytes} B).`,
    "",
  ].join("\n");
}

export function buildCliAnswer(
  projectPath: string,
  browser: string,
  frameOverrides: Body = {},
): { code: number; stdout: string; stderr: string } {
  return {
    code: 0,
    stdout: `${JSON.stringify(buildFrame(projectPath, [browser], frameOverrides))}\n`,
    stderr: buildNarration(browser),
  };
}

export function zipArtifacts(
  name: string,
  version: string,
  browser: string,
  options: { source?: boolean; zipFilename?: string } = {},
): Array<{ kind: "dist" | "source"; path: string; size: number }> {
  const stem = options.zipFilename ?? `${name}-${version}`;
  const out: Array<{ kind: "dist" | "source"; path: string; size: number }> = [
    { kind: "dist", path: `/tmp/project/dist/${stem}-${browser}.zip`, size: 4_096 },
  ];
  if (options.source) {
    out.push({ kind: "source", path: `/tmp/project/dist/${stem}-source.zip`, size: 6_144 });
  }
  return out;
}

export function doctorFrame(
  legs: Array<{ check: string; status: "pass" | "fail" | "warn" | "skip"; detail: string; remediation?: string }>,
  browser = "chrome",
): Body {
  const failed = legs.filter((leg) => leg.status === "fail");
  const remediation = failed.find((leg) => leg.remediation)?.remediation;
  return {
    schema: 1,
    ok: failed.length === 0,
    command: "doctor",
    browser,
    status: failed.length === 0 ? "healthy" : "unhealthy",
    value: legs,
    error:
      failed.length === 0
        ? null
        : { code: "E_DOCTOR", message: `${failed.length} of ${legs.length} doctor checks failed.` },
    ...(remediation ? { hint: remediation } : {}),
    warnings: [],
  };
}

export function evalFrame(result: unknown, context = "background", overrides: Body = {}): Body {
  return {
    schema: 1,
    ok: true,
    command: "eval",
    status: "ok",
    value: result,
    error: null,
    warnings: [],
    ...overrides,
  };
}

const EVAL_STATUS_FOR_CODE: Record<string, string> = {
  E_TIMEOUT: "timeout",
  E_SESSION_NOT_FOUND: "not-found",
  E_TARGET_NOT_FOUND: "not-found",
  E_CONTROL_DENIED: "denied",
  E_EVAL_REFUSED: "denied",
  E_CSP_BLOCKS_EVAL: "denied",
  E_TOKEN_MISSING: "denied",
  E_ARGS: "usage",
  E_FLAG_VALUE_INVALID: "usage",
};

export function evalRefusal(
  error: { code: string; message: string; name: string; engine?: string; hint?: string },
  options: { truncated?: boolean } = {},
): Body {
  return {
    schema: 1,
    ok: false,
    command: "eval",
    status: EVAL_STATUS_FOR_CODE[error.code] ?? "failed",
    value: null,
    error: { engine: "chromium", ...error },
    ...(options.truncated ? { truncated: true } : {}),
    warnings: [],
  };
}


export function actVerbAnswer(frame: Body, tool: string): string {
  return JSON.stringify({ ...frame, command: tool });
}

export function reloadFrame(target: "background" | number = "background", overrides: Body = {}): Body {
  return actFrame("reload", target === "background" ? { reloading: true } : { reloaded: target }, overrides);
}

export function stampExecutorDetached(contractFile: string, at = new Date().toISOString()): void {
  const prev = JSON.parse(fs.readFileSync(contractFile, "utf8")) as Body;
  if (typeof prev.executorAttachedAt !== "string") return;
  prev.runtime = "detached";
  prev.executorDetachedAt = at;
  prev.ts = at;
  fs.writeFileSync(contractFile, JSON.stringify(prev, null, 2));
}

export function stampExecutorAttached(contractFile: string, at = new Date().toISOString()): void {
  const prev = JSON.parse(fs.readFileSync(contractFile, "utf8")) as Body;
  prev.runtime = "attached";
  delete prev.executorDetachedAt;
  if (typeof prev.executorAttachedAt === "string") {
    prev.ts = at;
  } else {
    prev.executorAttachedAt = at;
  }
  fs.writeFileSync(contractFile, JSON.stringify(prev, null, 2));
}

export const ENGINE_WRITERS = {
  writeEngineDist: { file: "extension-develop/dist/840~0.mjs", marker: "getDistPath" },
  readyContract: { file: "extension-develop/dist/832~0.mjs", marker: "writeReady" },
  safariDevContract: { file: "extension/dist/browsers.cjs", marker: "stampReadyWebDriver" },
  attachedDevContract: { file: "extension/dist/browsers.cjs", marker: "stampReadyBrowser" },
  errorContract: { file: "extension-develop/dist/832~0.mjs", marker: "writeError" },
  logHeader: { file: "extension-develop/dist/dev-server~0.mjs", marker: "writeHeader" },
  logEvent: { file: "extension-develop/dist/rspack-config~0.mjs", marker: "messageParts" },
  logGap: { file: "extension-develop/dist/dev-server~0.mjs", marker: "maybeNoteDrops" },
  actFrame: { file: "extension/dist/cli.cjs", marker: "runCommand" },
  cliRefusal: { file: "extension/dist/cli.cjs", marker: "fail" },
  tabRows: { file: "extension-develop/dist/rspack-config~0.mjs", marker: "tabs.query" },
  buildSummary: { file: "extension-develop/dist/840~0.mjs", marker: "build-summary.json" },
  buildFrame: { file: "extension/dist/cli.cjs", marker: "--output json" },
  buildNarration: { file: "extension/dist/cli.cjs", marker: "Extension built for production" },
  doctorFrame: { file: "extension/dist/cli.cjs", marker: "runDoctor" },
  evalFrame: { file: "extension/dist/cli.cjs", marker: "buildActEnvelope" },
  evalRefusal: { file: "extension/dist/cli.cjs", marker: "statusForCode" },
  reloadFrame: { file: "extension-develop/dist/rspack-config~0.mjs", marker: "reloading" },
  stampExecutorDetached: { file: "extension-develop/dist/832~0.mjs", marker: "stampExecutorDetached" },
} as const;
