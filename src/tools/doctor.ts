// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exactVersion, pinnedCliVersion, runExtensionCli } from "../lib/exec";
import {
  outputFlagRefusalMessage,
  refusedTheOutputFlag,
} from "../lib/engine-version";
import { toMcpSpeak } from "../lib/act";
import { envelope, isEnvelope } from "../lib/envelope";
import { resolveSessionBrowser } from "../lib/session-browser";
import { readLogEvents } from "./logs-filter";
import {
  readyContractPath,
  sessionArtifactsRootDir,
} from "../lib/session-paths";
import type { ReadyContract } from "../lib/types";

/* @invariant Deliberately NOT the engine's readReadyContract, which
   lib/session-paths.ts re-exports and tools/logs.ts uses. That one exists to
   answer whether this process can dial the control channel, so it returns null
   whenever controlPort is not a number or instanceId is missing, and the
   ReadyContractInfo it returns has no code, errors or message.

   Both are wrong for a diagnosis. A session whose build failed and which has no
   control port is the ordinary case here, not a corner: the engine's dev server
   catches a failure to bind the control server and keeps running with its
   control port left null, and a one-shot build receipt never sets one at all.
   Either way ready.json says status:"error" and carries the build errors, and
   either way the engine's reader answers null. Calling it here would drop the
   runtime-errors check on exactly the session someone ran doctor to understand,
   and report healthy. This parse is unconditional for that reason. */
function readContractForDiagnosis(
  projectPath: string,
  browser: string,
): ReadyContract | null {
  try {
    const raw = fs.readFileSync(
      readyContractPath(projectPath, browser),
      "utf8",
    );
    return JSON.parse(raw) as ReadyContract;
  } catch {
    return null;
  }
}

/* @invariant The session diagnosed is the one that exists, ready or not.

   resolveSessionBrowser only counts contracts whose status is "ready", which
   is right for every tool that needs a drivable session and wrong for this
   one: the session someone runs doctor on is routinely the one whose contract
   says "error". Letting the shared resolver fall back to chrome made doctor
   diagnose a browser with no session at all, label the report with it, and
   read the wrong (absent) contract, so the walk saw a chromium label and a
   healthy verdict over a chrome session that had failed. When the resolver
   answers "fallback", any browser with a ready.json on disk, newest first and
   whatever its status, outranks the hardcoded default. */
function sightedContractBrowser(projectPath: string): string | null {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(sessionArtifactsRootDir(projectPath));
  } catch {
    return null;
  }
  let best: { browser: string; mtimeMs: number } | null = null;
  for (const dir of dirs) {
    try {
      const stat = fs.statSync(readyContractPath(projectPath, dir));
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { browser: dir, mtimeMs: stat.mtimeMs };
      }
    } catch {
    }
  }
  return best ? best.browser : null;
}

export const schema = {
  name: "extension_doctor",
  description:
    "Diagnose a dev session end to end: ready contract, dev-server process, control-port agreement, control channel, eval token, executor, browser liveness. This returns one {check, status, detail, remediation?} per leg, in dependency order. Read a 'skip' as blocked, not as a pass: it names the check that blocked it. Run this first when any act tool (storage, reload, eval, open) errors unexpectedly. Call it with no projectPath for a pre-flight environment check (node, the Extension.js CLI, the template cache) before any project exists.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description:
          "Path to the extension project root. Omit for a pre-flight environment check with no project.",
      },
      browser: {
        type: "string",
        description:
          "Browser session to diagnose. Defaults to the active dev session's browser for this project.",
      },
    },
  },
};

async function environmentPreflight(): Promise<string> {
  const checks: Array<{
    check: string;
    status: "pass" | "warn" | "fail";
    detail: string;
    remediation?: string;
  }> = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    check: "node",
    status: nodeMajor >= 20 ? "pass" : "fail",
    detail: `Node ${process.versions.node} on ${process.platform}/${process.arch}`,
    remediation: nodeMajor >= 20 ? undefined : "Extension.js needs Node >= 20.18.",
  });

  const { code, stdout, stderr } = await runExtensionCli(["--version"], {
    timeoutMs: 60_000,
  });
  const cliVersion = stdout.trim() || stderr.trim();
  checks.push({
    check: "extension-cli",
    status: code === 0 ? "pass" : "fail",
    detail:
      code === 0
        ? `extension CLI resolvable (${cliVersion})`
        : "extension CLI could not be resolved",
    remediation:
      code === 0
        ? undefined
        : "Install locally (npm i -D extension) or rely on npx; check network access to the npm registry.",
  });

  const cacheFile = path.join(
    os.homedir(),
    ".cache",
    "extension-js",
    "templates-meta.json",
  );
  const cacheExists = fs.existsSync(cacheFile);
  checks.push({
    check: "template-cache",
    status: cacheExists ? "pass" : "warn",
    detail: cacheExists
      ? `Template catalog cached at ${cacheFile}`
      : "Template catalog not cached yet (extension_templates will fetch it)",
  });

  const healthy = checks.every((c) => c.status !== "fail");
  return envelope({
    ok: healthy,
    command: schema.name,
    status: healthy ? "healthy" : "unhealthy",
    value: { mode: "environment", checks },
    hint: "Pass projectPath to diagnose a live dev session end-to-end.",
  });
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text ?? String(value);
  } catch {
    return String(value);
  }
}

export function recentErrorLogs(
  projectPath: string,
  browser: string,
  max = 5,
): string[] {
  const errs: string[] = [];
  for (const event of readLogEvents(projectPath, browser, { level: "error" })) {
    const ev = event as {
      messageParts?: unknown[];
      errorName?: string;
      stack?: string;
      args?: unknown[];
      message?: string;
      text?: string;
    };
    const parts = Array.isArray(ev.messageParts)
      ? ev.messageParts
      : Array.isArray(ev.args)
        ? ev.args
        : null;
    let msg = parts
      ? parts.map((p) => (typeof p === "string" ? p : safeStringify(p))).join(" ")
      : ev.message || ev.text || "";
    if (!msg && ev.errorName) msg = ev.stack ? `${ev.errorName}: ${ev.stack}` : ev.errorName;
    msg = msg.replace(/\s+/g, " ").trim();
    if (msg) errs.push(msg.slice(0, 300));
  }
  return [...new Set(errs)].slice(-max);
}

function projectEngineVersion(projectPath: string): string | null {
  try {
    const p = path.resolve(
      projectPath,
      "node_modules",
      "extension",
      "package.json",
    );
    return JSON.parse(fs.readFileSync(p, "utf8")).version || null;
  } catch {
    return null;
  }
}

function capabilityProbeChecks(parsed: unknown): unknown {
  return isEnvelope(parsed)
    ? (parsed.value as { checks?: unknown } | null)?.checks
    : parsed;
}

export async function handler(args: {
  projectPath?: string;
  browser?: string;
}): Promise<string> {
  if (!args.projectPath) {
    return environmentPreflight();
  }
  const projectPath = args.projectPath;
  const resolved = resolveSessionBrowser(projectPath, args.browser);
  const browser =
    resolved.source === "fallback"
      ? (sightedContractBrowser(projectPath) ?? resolved.browser)
      : resolved.browser;
  const { code, stdout, stderr } = await runExtensionCli(
    ["doctor", projectPath, "--browser", browser, "--output", "json"],
    { cwd: projectPath },
  );

  /* @invariant The refusal is checked before the parse, not caught by it.
   *
   * A refused flag would otherwise fall through to the catch below and be
   * reported as E_CLI carrying commander's line about `--output`, under a hint
   * that only guesses the install "may predate it". That is the diagnosis this
   * tool exists to give other tools, so it is the last place that should be
   * guessing: doctor is what an agent is told to run when anything else looks
   * wrong, and it has the floor table and the version probe in hand.
   */
  if (refusedTheOutputFlag(stderr ?? "")) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "engine-too-old",
      error: {
        code: "E_ENGINE_TOO_OLD",
        name: "CliError",
        message: await outputFlagRefusalMessage("doctor", "doctor", projectPath),
      },
      hint: "Until then, extension_logs without follow still reads this project's log file, and the session's ready.json still records how the last build ended.",
    });
  }

  const out = stdout.trim();
  try {
    const parsed = JSON.parse(out);
    const checks = capabilityProbeChecks(parsed);
    if (!Array.isArray(checks)) throw new Error("not a check array");
    for (const check of checks) {
      if (typeof check.detail === "string") check.detail = toMcpSpeak(check.detail);
      if (typeof check.remediation === "string") {
        check.remediation = toMcpSpeak(check.remediation);
      }
    }

    let healthy = code === 0;
    const contract = readContractForDiagnosis(projectPath, browser);
    if (contract?.status === "error") {
      healthy = false;
      const browserExited =
        contract.code === "browser_exited" ||
        contract.browserExitCode !== undefined;
      const detail = browserExited
        ? `The ${browser} browser for this session exited unexpectedly${
            contract.browserExitCode != null
              ? ` (exit code ${contract.browserExitCode})`
              : ""
          }; the extension may have been rejected or the browser crashed. The session cannot be driven.`
        : contract.errors && contract.errors.length
          ? contract.errors.join("; ")
          : contract.message ||
            "The dev session recorded status: error in ready.json.";
      checks.push({
        check: "runtime-errors",
        status: "fail",
        detail: toMcpSpeak(detail),
        remediation: browserExited
          ? "Read extension_logs and the session log for the rejection cause, call extension_stop to clean up, then relaunch."
          : "The build or extension load failed. Fix the reported error, let the dev server recompile, then re-run doctor.",
      });
    } else {
      const errs = recentErrorLogs(projectPath, browser);
      if (errs.length) {
        healthy = false;
        checks.push({
          check: "runtime-errors",
          status: "fail",
          detail: `Recent error-level logs: ${errs.join(" | ")}`,
          remediation:
            "The extension is throwing at runtime. Inspect with extension_logs. A chrome.* API called without its permission is a common cause: extension_manifest_validate catches a permission MISSING FROM permissions[], but it does not model host-permission scope (e.g. webRequest with no matching host_permissions) or gesture requirements (e.g. activeTab without a user gesture), so a valid:true there does not rule those out.",
        });
      }
    }

    const engineVersion = projectEngineVersion(projectPath);
    if (engineVersion) {
      const pin = pinnedCliVersion();
      const mismatch =
        pin !== "" &&
        pin !== "latest" &&
        exactVersion(engineVersion) !== exactVersion(pin);
      checks.push({
        check: "project-engine",
        status: mismatch ? "warn" : "pass",
        detail: `project-local extension@${engineVersion}${mismatch ? `, but the MCP pins extension@${pin}; the dev loop uses the project bin, not the pin` : ""}`,
        ...(mismatch
          ? {
              remediation: `Run \`(cd ${projectPath} && npm i -D extension@${pin})\` to match the pinned engine.`,
            }
          : {}),
      });
    }
    return envelope({
      ok: healthy,
      command: schema.name,
      status: healthy ? "healthy" : "unhealthy",
      value: {
        browser,
        ...(engineVersion ? { engineVersion } : {}),
        checks,
      },
    });
  } catch {
    /* @invariant The CLI's own report survives the parse failure.
     *
     * Doctor is what an agent runs when everything else looks wrong, so this
     * is the last envelope allowed to swallow a diagnosis. When the engine
     * exits nonzero its stdout usually carries the full check list and the
     * real remediation in prose; discarding it and guessing "stale CLI"
     * reported the one tool built to explain failures as itself unexplained.
     * The stale-CLI guess is only offered when there is no output to show. */
    const message = stderr.trim() || `extension exited with code ${code}`;
    const cliReport = toMcpSpeak(out).trim().slice(0, 4000);
    return envelope({
      ok: false,
      command: schema.name,
      status: "cli-failed",
      error: {
        code: "E_CLI",
        name: "CliError",
        message: toMcpSpeak(message),
      },
      value: {
        browser,
        ...(cliReport ? { cliReport } : {}),
      },
      hint: cliReport
        ? "cliReport is the doctor's own output, unparsed: read the failing checks and remediations there."
        : "extension doctor requires a recent extension CLI, the project's local install may predate it.",
    });
  }
}
