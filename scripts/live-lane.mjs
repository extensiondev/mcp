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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const README_BROWSER_ORDER = [
  "chrome",
  "edge",
  "firefox",
  "brave",
  "opera",
  "vivaldi",
  "yandex",
  "waterfox",
  "librewolf",
  "zen",
  "floorp",
  "safari",
];


/* @invariant EVERY BROWSER THIS LANE LAUNCHES IS HEADLESS. A headed browser on
 * macOS activates itself and takes the operator's keyboard, so the engine is
 * started with EXTENSION_HEADLESS=1, which the pinned CLI reads for Chromium
 * (--headless=new) and for Gecko (-headless). Safari has no headless mode and
 * needs an attended setup, so it is refused here unless --allow-safari is
 * passed by a person sitting at the machine. */
const HEADLESS_ENV = { EXTENSION_HEADLESS: "1", MOZ_HEADLESS: "1" };

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0) return process.argv[at + 1] ?? fallback;

  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));

  return inline ? inline.slice(name.length + 3) : fallback;
};

const has = (name) => process.argv.includes(`--${name}`);

const outPath = path.resolve(flag("out", path.join(root, "live-lane.md")));
const perBrowserCapMs = Number(flag("timeout-min", "10")) * 60_000;
const callTimeoutMs = Number(flag("call-timeout-sec", "120")) * 1000;
const keepScratch = has("keep");
const noteChars = Number(flag("note-chars", "160"));
const allowSafari = has("allow-safari");
const requested = String(flag("browsers", "") || "")
  .split(",")
  .map((b) => b.trim().toLowerCase())
  .filter(Boolean);

const newestSrcMtime = (dir) => {
  let newest = 0;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSrcMtime(full));
    else newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }

  return newest;
};

const ensureBuilt = () => {
  const dist = path.join(root, "dist", "module.js");
  const stale = !fs.existsSync(dist) || fs.statSync(dist).mtimeMs < newestSrcMtime(path.join(root, "src"));
  if (!stale) return;

  process.stderr.write("dist/module.js is missing or older than src, running pnpm compile\n");
  execFileSync("pnpm", ["compile"], { cwd: root, stdio: "inherit" });
};

const parseEnvelope = (result) => {
  const text = result?.content?.find((c) => c.type === "text")?.text ?? "";

  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, status: "unparseable", error: { message: text.slice(0, 200) } };
  }
};

const firstNote = (env) => {
  if (env.error?.message) return String(env.error.message);
  if (Array.isArray(env.warnings) && env.warnings.length) return String(env.warnings[0]);
  if (env.hint) return String(env.hint);

  return "";
};

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const clip = (text, n = noteChars) => (text.length > n ? `${text.slice(0, n - 1)}...` : text);

const withTimeout = (promise, ms, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

async function openServer(sessionDir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "bin", "extension-mcp.js"), "--features=local"],
    env: {
      ...process.env,
      ...HEADLESS_ENV,
      EXTENSION_MCP_SESSION_DIR: sessionDir,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "live-lane", version: pkg.version });
  await client.connect(transport);
  transport.stderr?.on("data", () => {});

  return { client, transport };
}

async function call(client, tool, args) {
  const started = Date.now();
  let env;

  try {
    const result = await client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: callTimeoutMs,
    });
    env = parseEnvelope(result);
  } catch (err) {
    env = { ok: false, status: "threw", error: { message: err instanceof Error ? err.message : String(err) } };
  }

  return { tool, ms: Date.now() - started, ok: env.ok === true, status: String(env.status ?? ""), note: firstNote(env), env };
}

/* @invariant A DOCUMENTED REFUSAL IS NOT A FAILURE OF THE LANE. The README
 * says Safari's MV3 background CSP blocks eval, and only Safari's: measured
 * 2026-10-07 on Extension.js 4.1.32, a Firefox MV3 event page answered
 * background evals ok, so a Gecko refusal here is a failure the verdict
 * names, not a promise coming true. Anything else that answers ok: false is
 * a failure and is named in the verdict. */
const documentedOutcome = (browser, step, row) => {
  if (row.ok) return false;

  if (step.tool === "extension_eval" && step.args.context === "background" && browser === "safari") {
    return /csp|eval|content security|unsupported|refus|blocked/i.test(`${row.status} ${row.note}`);
  }

  return false;
};

function stepsFor(browser, scratch) {
  const projectName = `lane-${browser}`;
  const ctx = { projectPath: path.join(scratch, projectName) };

  return [
    { tool: "extension_create", args: { projectName, parentDir: scratch, template: "action", install: false }, after: (env) => { if (env.value?.projectPath) ctx.projectPath = env.value.projectPath; } },
    { tool: "extension_build", args: () => ({ projectPath: ctx.projectPath, browser }) },
    { tool: "extension_dev", args: () => ({ projectPath: ctx.projectPath, browser, allowEval: true }) },
    { tool: "extension_wait", args: () => ({ projectPath: ctx.projectPath, browser, timeoutMs: 90_000 }) },
    { tool: "extension_logs", args: () => ({ projectPath: ctx.projectPath, browser, limit: 20 }) },
    { tool: "extension_list_extensions", args: () => ({ projectPath: ctx.projectPath, browser }) },
    { tool: "extension_open", args: () => ({ projectPath: ctx.projectPath, browser, surface: "popup" }) },
    { tool: "extension_dom_snapshot", args: () => ({ projectPath: ctx.projectPath, browser, context: "popup" }) },
    { tool: "extension_eval", args: () => ({ projectPath: ctx.projectPath, browser, context: "background", expression: "typeof chrome" }) },
    { tool: "extension_storage", args: () => ({ projectPath: ctx.projectPath, browser, action: "get", area: "local" }) },
    { tool: "extension_reload", args: () => ({ projectPath: ctx.projectPath, browser }) },
    {
      tool: "extension_assert",
      args: () => ({
        projectPath: ctx.projectPath,
        browser,
        expect: [{ assert: "background-worker-booted" }, { assert: "console-errors-empty" }],
      }),
    },
  ];
}

async function runBrowser(browser, scratchRoot) {
  const sessionDir = fs.mkdtempSync(path.join(scratchRoot, `session-${browser}-`));
  const scratch = fs.mkdtempSync(path.join(scratchRoot, `projects-${browser}-`));
  const rows = [];
  const { client, transport } = await openServer(sessionDir);
  const steps = stepsFor(browser, scratch);
  let capped = null;

  const walk = async () => {
    for (const step of steps) {
      const args = typeof step.args === "function" ? step.args() : step.args;
      const row = await call(client, step.tool, args);
      row.documented = documentedOutcome(browser, { ...step, args }, row);
      rows.push(row);
      step.after?.(row.env);
      process.stderr.write(`  ${browser} ${step.tool} ${row.ok ? "ok" : row.documented ? "documented" : "FAIL"} ${row.status} ${row.ms}ms\n`);
    }
  };

  try {
    await withTimeout(walk(), perBrowserCapMs, `${browser} lane`);
  } catch (err) {
    capped = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  ${browser} capped: ${capped}\n`);
  }

  let stopRow;

  try {
    stopRow = await withTimeout(call(client, "extension_stop", { all: true }), callTimeoutMs, `${browser} stop`);
  } catch (err) {
    stopRow = { tool: "extension_stop", ms: 0, ok: false, status: "threw", note: err instanceof Error ? err.message : String(err), env: {} };
  }

  stopRow.documented = false;
  rows.push(stopRow);
  process.stderr.write(`  ${browser} extension_stop ${stopRow.ok ? "ok" : "FAIL"} ${stopRow.status} ${stopRow.ms}ms\n`);

  try {
    await client.close();
  } catch {
    /* already gone */
  }

  try {
    await transport.close();
  } catch {
    /* already gone */
  }

  if (!keepScratch) {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }

  return { browser, rows, capped };
}

async function detectInstalled(scratchRoot) {
  const sessionDir = fs.mkdtempSync(path.join(scratchRoot, "session-detect-"));
  const { client, transport } = await openServer(sessionDir);
  const row = await call(client, "extension_browsers", { action: "detect" });
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  fs.rmSync(sessionDir, { recursive: true, force: true });
  const available = row.env?.value?.summary?.available ?? [];

  return README_BROWSER_ORDER.filter((b) => available.includes(b));
}

const verdictFor = (run) => {
  if (run.capped) return `CAPPED: ${run.capped}`;

  const failing = run.rows.find((r) => !r.ok && !r.documented);

  if (!failing) {
    const documented = run.rows.filter((r) => r.documented).map((r) => r.tool);

    return documented.length ? `PASS (documented refusal on ${documented.join(", ")})` : "PASS";
  }

  return `FAIL at ${failing.tool}: ${failing.status}${failing.note ? ` (${clip(failing.note, 120)})` : ""}`;
};

const renderMarkdown = (runs, meta) => {
  const lines = [];
  lines.push(`## Live lane ${meta.startedAt}`);
  lines.push("");
  lines.push(`Server @extension.dev/mcp ${pkg.version} over stdio with --features=local, engine pin extension-develop ${pkg.dependencies["extension-develop"]}, headless (EXTENSION_HEADLESS=1), host ${os.platform()} ${os.release()} ${os.arch()}, node ${process.version}. Template: action.`);
  lines.push("");
  lines.push("| Browser | Verdict |");
  lines.push("| --- | --- |");
  for (const run of runs) lines.push(`| ${run.browser} | ${cell(verdictFor(run))} |`);
  lines.push("");
  lines.push("| Browser | Step | ms | ok | status | note |");
  lines.push("| --- | --- | ---: | --- | --- | --- |");

  for (const run of runs) {
    for (const r of run.rows) {
      const ok = r.ok ? "yes" : r.documented ? "documented" : "NO";
      lines.push(`| ${run.browser} | ${r.tool} | ${r.ms} | ${ok} | ${cell(r.status)} | ${cell(clip(r.note))} |`);
    }
  }

  lines.push("");

  return lines.join("\n");
};

async function main() {
  ensureBuilt();
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-live-lane-"));
  const startedAt = new Date().toISOString();
  let browsers = requested.length ? requested : await detectInstalled(scratchRoot);
  const refused = browsers.filter((b) => b === "safari" && !allowSafari);
  browsers = browsers.filter((b) => !refused.includes(b));
  if (refused.length) process.stderr.write("safari skipped: it has no headless mode and needs an attended setup (pass --allow-safari at the machine)\n");

  if (!browsers.length) {
    process.stderr.write("No browser to run.\n");
    process.exit(2);
  }

  process.stderr.write(`Browsers: ${browsers.join(", ")}\n`);
  const runs = [];

  for (const browser of browsers) {
    process.stderr.write(`\n${browser}\n`);

    try {
      runs.push(await runBrowser(browser, scratchRoot));
    } catch (err) {
      runs.push({ browser, rows: [], capped: `lane threw before any step: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const md = renderMarkdown(runs, { startedAt });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const header = fs.existsSync(outPath) ? "" : "# Live lane verdicts\n\nEach run below drove the real MCP server and the real pinned engine, headless, one browser at a time.\n\n";
  fs.appendFileSync(outPath, `${header + md  }\n`);
  process.stdout.write(md);
  if (!keepScratch) fs.rmSync(scratchRoot, { recursive: true, force: true });

  const allPass = runs.every((run) => verdictFor(run).startsWith("PASS"));
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
