// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runExtensionCli } from "../lib/exec";
import { toMcpSpeak } from "../lib/act";
import { resolveSessionBrowser } from "../lib/session-browser";
import type { ReadyContract } from "../lib/types";

function readReadyContract(
  projectPath: string,
  browser: string,
): ReadyContract | null {
  try {
    const raw = fs.readFileSync(
      path.resolve(projectPath, "dist", "extension-js", browser, "ready.json"),
      "utf8",
    );
    return JSON.parse(raw) as ReadyContract;
  } catch {
    return null;
  }
}

export const schema = {
  name: "extension_doctor",
  description:
    "Diagnose a dev session end-to-end: ready contract, dev-server process, control-port agreement, control channel, eval token, executor, and browser liveness. Returns one {check, status, detail, remediation?} entry per leg in dependency order, a 'skip' names the check that blocked it and is NOT a pass. Run this first when any act tool (storage/reload/eval/open) errors unexpectedly. Wraps `extension doctor`. Call with no projectPath for a pre-flight environment check (node, extension CLI, template cache) before any project exists.",
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
      : "Template catalog not cached yet (first extension_list_templates will fetch it)",
  });

  const healthy = checks.every((c) => c.status !== "fail");
  return JSON.stringify({
    mode: "environment",
    healthy,
    checks,
    hint: "Pass projectPath to diagnose a live dev session end-to-end.",
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// Recent error-level logs from the dev session, so a runtime crash (background
// throwing on every event, now captured since engine #55) is surfaced even when
// ready.json still says "ready" and the harness legs pass.
export function recentErrorLogs(
  projectPath: string,
  browser: string,
  max = 5,
): string[] {
  const file = path.resolve(
    projectPath,
    "dist",
    "extension-js",
    browser,
    "logs.ndjson",
  );
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const errs: string[] = [];
  for (const line of lines) {
    let ev: {
      level?: string;
      messageParts?: unknown[];
      errorName?: string;
      stack?: string;
      // Pre-LOG_EVENT_VERSION shapes, kept as fallbacks.
      args?: unknown[];
      message?: string;
      text?: string;
    };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || ev.level !== "error") continue;
    // The engine's LogEvent carries the payload in `messageParts` (uncaught
    // errors ship "<message>\n<stack>" as a single part). Reading `args` here
    // silently dropped every row, which is why doctor still reported
    // healthy:true over a crashing background in the 4.9.0 swarm.
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
  // The same throw repeats on every event; show the distinct tail instead of
  // five copies of one error.
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

export async function handler(args: {
  projectPath?: string;
  browser?: string;
}): Promise<string> {
  if (!args.projectPath) {
    return environmentPreflight();
  }
  const projectPath = args.projectPath;
  const { browser } = resolveSessionBrowser(projectPath, args.browser);
  const { code, stdout, stderr } = await runExtensionCli(
    ["doctor", projectPath, "--browser", browser, "--output", "json"],
    { cwd: projectPath },
  );

  const out = stdout.trim();
  try {
    const checks = JSON.parse(out);
    if (!Array.isArray(checks)) throw new Error("not a check array");
    for (const check of checks) {
      if (typeof check.detail === "string") check.detail = toMcpSpeak(check.detail);
      if (typeof check.remediation === "string") {
        check.remediation = toMcpSpeak(check.remediation);
      }
    }

    // The CLI doctor reports harness legs (ports, token, executor) but does not
    // fail on an error recorded in the ready contract, a build or extension
    // load failure would otherwise read as healthy. Inline it and downgrade.
    let healthy = code === 0;
    const contract = readReadyContract(projectPath, browser);
    if (contract?.status === "error") {
      healthy = false;
      // Engines with the bug-71/72 fixes stamp code:"browser_exited" when the
      // launched browser died; name that instead of the generic build wording,
      // because the remediation is entirely different.
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
      // ready.json says ready, but the extension may still be throwing at
      // runtime (e.g. a missing permission for a called chrome.* API). Surface
      // recent error-level logs and downgrade, so doctor isn't falsely healthy.
      const errs = recentErrorLogs(projectPath, browser);
      if (errs.length) {
        healthy = false;
        checks.push({
          check: "runtime-errors",
          status: "fail",
          detail: `Recent error-level logs: ${errs.join(" | ")}`,
          // The old copy said manifest_validate "now checks this" for permission
          // causes without qualification. It checks permissions[] MEMBERSHIP
          // only: it does not model host-permission scope or gesture
          // requirements. Two personas followed the pointer, got valid:true, and
          // burned a debug cycle; in one case it steered them off the real
          // cause. Say exactly what the check covers.
          remediation:
            "The extension is throwing at runtime. Inspect with extension_logs. A chrome.* API called without its permission is a common cause: extension_manifest_validate catches a permission MISSING FROM permissions[], but it does not model host-permission scope (e.g. webRequest with no matching host_permissions) or gesture requirements (e.g. activeTab without a user gesture), so a valid:true there does not rule those out.",
        });
      }
    }

    // Keep the project-local engine version visible in project mode (env mode
    // reports it; project mode dropped it) and flag when it differs from a pin
    // because the project bin, not EXTENSION_MCP_CLI_VERSION, drives the dev loop.
    const engineVersion = projectEngineVersion(projectPath);
    if (engineVersion) {
      const pin = String(process.env.EXTENSION_MCP_CLI_VERSION || "").trim();
      const mismatch =
        pin !== "" && pin !== "latest" && !engineVersion.includes(pin);
      checks.push({
        check: "project-engine",
        status: mismatch ? "warn" : "pass",
        detail: `project-local extension@${engineVersion}${mismatch ? `, but EXTENSION_MCP_CLI_VERSION=${pin}; the dev loop uses the project bin, not the pin` : ""}`,
        ...(mismatch
          ? {
              remediation: `Run \`(cd ${projectPath} && npm i -D extension@${pin})\` to match the pinned engine.`,
            }
          : {}),
      });
    }
    return JSON.stringify({
      browser,
      ...(engineVersion ? { engineVersion } : {}),
      healthy,
      checks,
    });
  } catch {
    const message = stderr.trim() || `extension exited with code ${code}`;
    return JSON.stringify({
      ok: false,
      error: {
        name: "CliError",
        message: toMcpSpeak(message),
        hint: "extension doctor requires a recent extension CLI, the project's local install may predate it.",
      },
    });
  }
}
