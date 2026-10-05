/* @invariant THESE ARE THE ENGINE'S REAL SHAPES, KEY FOR KEY, FROM ITS OWN
 * WRITERS. Each builder returns what extension-develop 4.1.31 (or its CLI)
 * writes today, with the file and symbol that writes it named beside it, so
 * a test that wants a session, a log line, a build or an act reply feeds the
 * client what the engine feeds it. A test that wants a degraded or older
 * shape has to say which key it changed. Hand-written shapes (`message` on a
 * log event, `{tabs: [...]}` on a list-tabs frame, a `ready.json` without
 * `schema: 1`) are how a run of defects stayed invisible.
 * When the pinned engine changes a writer, this file changes with it.
 */

type Body = Record<string, unknown>;

const NOW = "2026-10-05T12:00:00.000Z";

/* extension-develop/dist/832~0.mjs, the `base` object and `writeReady` of the
 * ready-contract writer: the fields every dev session stamps once it is
 * ready and the browser launcher has stamped its ports. `start` and
 * `preview` share the base with `port: null`, `controlPort: null` and no
 * instance, control or logs path. `build` leaves `command: "build"` with the
 * finished build's pid. */
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
    host: "localhost",
    controlPort: command === "dev" ? 43210 : null,
    toolchainVersion: "4.1.31",
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

/* The launcher's stamps on a dev contract once the browser is up and the
 * executor has connected (CLI: the ready.json stamps after launch). */
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

/* A dev browser that died AFTER ready: the engine keeps `status: "ready"`,
 * adds the exit stamps and flips `runtime` to "detached" while keeping
 * `executorAttachedAt` (832~0.mjs `writeReady`, the `sameRun` block). */
export function browserExitedAfterReadyContract(browser: string, overrides: Body = {}): Body {
  return attachedDevContract(browser, {
    browserExitedAt: NOW,
    browserExitCode: 0,
    browserExitSignal: null,
    executorDetachedAt: NOW,
    runtime: "detached",
    ...overrides,
  });
}

/* `status: "error"` contracts, with the codes the writer stamps. */
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

/* extension-develop/dist/dev-server~0.mjs `LogsFileWriter.writeHeader`. */
export function logHeader(runId: string, rotatedFrom: string | null = null): Body {
  return { v: 1, type: "header", runId, startedAt: NOW, rotatedFrom };
}

/* The executor's console capture (rspack-config~0.mjs, the `send({type:
 * "log", event})` site): no `message` key, the parts are an array. */
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

/* `LogsFileWriter.maybeNoteDrops`. */
export function logGap(dropped: number): Body {
  return { v: 1, type: "gap", reason: "disk_slow", dropped };
}

export function logFile(runId: string, events: Body[], rotatedFrom: string | null = null): string {
  return [logHeader(runId, rotatedFrom), ...events]
    .map((line) => JSON.stringify(line))
    .join("\n")
    .concat("\n");
}

/* The CLI's act frame once the bridge answered (cli.cjs `runCommand`):
 * `command` is overwritten by this package with the tool name afterwards. */
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
  error: { name: string; message: string; code: string; hint?: string },
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

/* A refusal the CLI makes before it reaches the bridge (cli.cjs `fail()`):
 * no `type`, `cmdId` or `engine`. */
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

/* The executor's reply to `tabs.query` behind `--list-tabs`
 * (rspack-config~0.mjs): a plain array, never `{tabs: [...]}`. */
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

/* extension-develop/dist/840~0.mjs: the summary the build writes under
 * dist/extension-js/<browser>/build-summary.json, `zip_artifacts` included
 * when a zip was asked for (rspack-config~0.mjs names the archives). */
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
    ...overrides,
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

/* cli.cjs `runDoctor`: the frame's `value` is the check array. The legs a
 * dev session answers, in the order the CLI emits them. */
export function doctorFrame(
  legs: Array<{ check: string; status: "pass" | "fail" | "warn" | "skip"; detail: string; remediation?: string }>,
): Body {
  const failed = legs.filter((leg) => leg.status === "fail").length;
  return {
    schema: 1,
    ok: failed === 0,
    command: "doctor",
    status: failed === 0 ? "healthy" : "unhealthy",
    value: legs,
    error:
      failed === 0
        ? null
        : { code: "E_DOCTOR", message: `${failed} of ${legs.length} doctor checks failed.` },
    warnings: [],
  };
}

export const DOCTOR_CONTROL_OFF_DETAIL =
  "refused: control is off in the session that answered";
