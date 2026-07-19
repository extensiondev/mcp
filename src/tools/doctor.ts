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
    "Diagnose a dev session end-to-end: ready contract, dev-server process, control-port agreement, control channel, eval token, executor, and browser liveness. Returns one {check, status, detail, remediation?} entry per leg in dependency order — a 'skip' names the check that blocked it and is NOT a pass. Run this first when any act tool (storage/reload/eval/open) errors unexpectedly. Wraps `extension doctor`. Call with no projectPath for a pre-flight environment check (node, extension CLI, template cache) before any project exists.",
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
    // fail on an error recorded in the ready contract — a build or extension
    // load failure would otherwise read as healthy. Inline it and downgrade.
    let healthy = code === 0;
    const contract = readReadyContract(projectPath, browser);
    if (contract?.status === "error") {
      healthy = false;
      const detail =
        contract.errors && contract.errors.length
          ? contract.errors.join("; ")
          : contract.message ||
            "The dev session recorded status: error in ready.json.";
      checks.push({
        check: "runtime-errors",
        status: "fail",
        detail: toMcpSpeak(detail),
        remediation:
          "The build or extension load failed. Fix the reported error, let the dev server recompile, then re-run doctor.",
      });
    }
    return JSON.stringify({ browser, healthy, checks });
  } catch {
    const message = stderr.trim() || `extension exited with code ${code}`;
    return JSON.stringify({
      ok: false,
      error: {
        name: "CliError",
        message: toMcpSpeak(message),
        hint: "extension doctor requires a recent extension CLI — the project's local install may predate it.",
      },
    });
  }
}
