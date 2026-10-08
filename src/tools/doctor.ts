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
import { nodeCheck } from "../lib/node-engine";
import {
  outputFlagRefusalMessage,
  refusedTheOutputFlag,
} from "../lib/engine-version";
import { toMcpSpeak } from "../lib/act";
import { envelope, isEnvelope } from "../lib/envelope";
import { resolveSessionBrowser } from "../lib/session-browser";
import { WEBKIT_FAMILY } from "../lib/browser-family";
import {
  readWebDriverSession,
  readWebDriverUnavailableReason,
  WebDriverClient,
} from "../lib/webdriver";
import {
  detectSafariAutomation,
  safariMcpAddCommand,
  SAFARI_MCP_SETTING,
} from "../lib/safari-automation";
import { readLogEvents, type LogQuery } from "./logs-filter";
import {
  readyContractPath,
  sessionArtifactsRootDir,
} from "../lib/session-paths";

import type { ReadyContract } from "../lib/types";

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
    "Diagnose a dev session end to end: ready contract, dev-server process, control-port agreement, control channel, eval token, executor, browser liveness. This returns one {check, status, detail, remediation?} per leg, in dependency order. Read a 'skip' as blocked, not as a pass: it names the check that blocked it. A session started with allowControl: false comes back ok:true with status 'read-only', not as an error: its control channel is off by choice. Run this first when any act tool (storage, reload, eval, open) errors unexpectedly. Call it with no projectPath for a pre-flight environment check (node, the Extension.js CLI, the template cache) before any project exists.",
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

  checks.push(nodeCheck(process.versions.node));

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

  if (process.platform === "darwin") {
    const safariBinary = "/Applications/Safari.app/Contents/MacOS/Safari";
    const automation = await detectSafariAutomation(
      fs.existsSync(safariBinary) ? safariBinary : null,
    );
    checks.push({
      check: "safari-agent",
      status: automation.mcp ? "pass" : "warn",
      detail: automation.mcp
        ? `Apple's Safari MCP server is available (${automation.safaridriver} --mcp)`
        : automation.helpUnreadable
          ? `${automation.helpUnreadable}; Safari's agent-readable window is unverified from this machine`
          : automation.safaridriver
            ? `${automation.safaridriver} has no --mcp flag, so Safari has no agent-readable window from this machine`
            : "No safaridriver found, so Safari has no agent-readable window from this machine",
      remediation: automation.mcp
        ? `Enable ${SAFARI_MCP_SETTING}, then add it beside this server: ${safariMcpAddCommand(automation.safaridriver)}. It reads pages in an isolated automation window and has no extension-aware tool.`
        : "Install Safari 27 (Software Update) or Safari Technology Preview 247+ for Apple's Safari MCP server. A Safari dev session still builds, opens and guides the enable step without it.",
    });
  }

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
  query: Omit<LogQuery, "level"> = {},
): string[] {
  const errs: string[] = [];

  for (const event of readLogEvents(projectPath, browser, {
    ...query,
    level: "error",
  })) {
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
  if (!isEnvelope(parsed)) return parsed;

  const value = parsed.value;
  if (Array.isArray(value)) return value;

  return (value as { checks?: unknown } | null)?.checks;
}

interface DoctorCheck {
  check: string;
  status: string;
  detail?: string;
  remediation?: string;
}

const CONTROL_OFF_BY_CHOICE =
  /\brefused: control is off in the session that answered\b/i;

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function reconcileRelaunchedBrowser(
  checks: DoctorCheck[],
  contract: { browserPid?: number | null } | null,
): boolean {
  const exitedLeg = checks.find(
    (leg) =>
      leg.check === "browser" &&
      leg.status === "fail" &&
      /\bexited\b/i.test(String(leg.detail ?? "")),
  );
  if (!exitedLeg) return false;

  const executorAnswered = checks.some(
    (leg) => leg.check === "executor" && leg.status === "pass",
  );
  const browserAlive =
    typeof contract?.browserPid === "number" && pidIsAlive(contract.browserPid);
  if (!executorAnswered && !browserAlive) return false;

  exitedLeg.status = "warn";
  exitedLeg.detail = `${exitedLeg.detail ?? "browser exited"}. ${
    browserAlive
      ? `The browser pid the launcher recorded (${contract?.browserPid}) is alive`
      : "The executor answered a probe after that exit"
  }, so the session is live and the recorded exit was an earlier process: Firefox hands a fresh profile to a relaunched process and the first one exits 0.`;

  exitedLeg.remediation =
    "Nothing to do. If a later call finds the session unreachable, extension_stop and extension_dev again.";

  return true;
}

function controlOffByChoiceLeg(checks: DoctorCheck[]): DoctorCheck | null {
  return (
    checks.find(
      (leg) =>
        leg.check === "control-channel" &&
        leg.status === "fail" &&
        typeof leg.detail === "string" &&
        CONTROL_OFF_BY_CHOICE.test(leg.detail),
    ) ?? null
  );
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
    const probed = capabilityProbeChecks(parsed);
    if (!Array.isArray(probed)) throw new Error("not a check array");

    const checks = probed as DoctorCheck[];
    const readOnlyLeg = controlOffByChoiceLeg(checks);

    for (const check of checks) {
      if (typeof check.detail === "string") check.detail = toMcpSpeak(check.detail);

      if (typeof check.remediation === "string") {
        check.remediation = toMcpSpeak(check.remediation);
      }
    }

    let healthy = code === 0;
    const contract = readContractForDiagnosis(projectPath, browser);
    const relaunched = reconcileRelaunchedBrowser(checks, contract);

    if (relaunched) {
      healthy = !checks.some((leg) => leg.status === "fail");
    }

    if (contract?.status === "error" && !relaunched) {
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
          detail: `${errs.length} distinct error-level log message(s) in this run, any context, any time since it started (up to 5 shown): ${errs.join(" | ")}`,
          remediation:
            "Error-level events were logged this run; read them with extension_logs (level: 'error') to see which context and when. A chrome.* API called without its permission is a common cause: extension_manifest_validate catches a permission MISSING FROM permissions[], but it does not model host-permission scope (e.g. webRequest with no matching host_permissions) or gesture requirements (e.g. activeTab without a user gesture), so a valid:true there does not rule those out.",
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

    if (WEBKIT_FAMILY.has(browser)) {
      const info = readWebDriverSession(projectPath, browser);
      const alive = info ? await new WebDriverClient(info).alive() : false;
      if (info && !alive) healthy = false;

      checks.push({
        check: "safari-window",
        status: info ? (alive ? "pass" : "fail") : "skip",
        detail: info
          ? alive
            ? `Safari automation window recorded by the dev session (safaridriver on port ${info.port}, session ${info.sessionId})`
            : `ready.json records a Safari automation session on port ${info.port}, but it no longer answers: the window or the driver is gone`
          : (() => {
              const reason = readWebDriverUnavailableReason(projectPath, browser);

              return reason
                ? `the dev session opened no safaridriver session: ${reason}; page-world eval and open by url use the bridge, and everything else already does`
                : "no safaridriver session recorded; page-world eval and open by url use the bridge, and everything else already does";
            })(),
        ...(info && !alive
          ? {
              remediation:
                "Stop and restart extension_dev --browser=safari; the session that recorded the window opens it again on the first package.",
            }
          : {}),
      });
    }

    const failures = checks.filter((leg) => leg.status === "fail");
    const readOnly =
      readOnlyLeg !== null && failures.length === 1 && failures[0] === readOnlyLeg;

    if (readOnly && readOnlyLeg) {
      readOnlyLeg.status = "warn";
      readOnlyLeg.detail = `read-only by choice: ${readOnlyLeg.detail}`;
      readOnlyLeg.remediation =
        "Nothing failed. To unlock the control verbs, call extension_dev again without allowControl: false (allowEval: true for eval as well) plus replace: true, which stops this session first; a plain second call is refused so the session does not fork.";
    }

    return envelope({
      ok: healthy || readOnly,
      command: schema.name,
      status: healthy ? "healthy" : readOnly ? "read-only" : "unhealthy",
      value: {
        browser,
        ...(engineVersion ? { engineVersion } : {}),
        ...(readOnly ? { readOnly: true } : {}),
        checks,
      },
      ...(readOnly
        ? {
            hint: "This session is read-only because it was started with allowControl: false, not because anything is wrong: logs, inspect, wait and doctor all work, while storage, reload, open, dom_snapshot and eval stay locked.",
          }
        : {}),
    });
  } catch {
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
