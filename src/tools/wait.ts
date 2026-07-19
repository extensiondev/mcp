// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import type { ReadyContract } from "../lib/types";
import { resolveSessionBrowser } from "../lib/session-browser";

// A single call is bounded below the MCP client's default request timeout
// (DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000 in the SDK), with margin for the
// request round-trip. Waiting longer than the client timeout would surface as
// an opaque transport error ("-32001 Request timed out") that also loses the
// session handle, instead of the graceful status below. A caller that needs to
// wait longer simply calls extension_wait again — it resumes polling the same
// on-disk contract, so the loop is idempotent and client-agnostic. (Progress
// notifications can't fix this: the SDK only resets the client timeout when the
// CLIENT sets resetTimeoutOnProgress, which the server cannot control.)
const SAFE_CEILING_MS = 50_000;

export const schema = {
  name: "extension_wait",
  description:
    "Wait for a running dev or start session to be ready. Polls the ready.json contract file and returns structured status. A single call is bounded to ~50s to stay under the MCP client request timeout; if it returns status:'timeout', call it again to keep waiting (polling resumes on the same contract).",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root",
      },
      browser: {
        type: "string",
        description:
          "Browser to check readiness for. Defaults to the active dev session's browser for this project.",
      },
      timeout: {
        type: "number",
        default: 45000,
        description:
          "Requested wait in milliseconds. Clamped to ~50s per call so it never exceeds the MCP client request timeout; call again to keep waiting for slower builds.",
      },
    },
    required: ["projectPath"],
  },
};

export async function handler(args: {
  projectPath: string;
  browser?: string;
  timeout?: number;
}): Promise<string> {
  const { browser } = resolveSessionBrowser(
    args.projectPath,
    args.browser,
    "chrome",
  );
  const requested = args.timeout ?? 45_000;
  const timeout = Math.min(Math.max(requested, 1_000), SAFE_CEILING_MS);
  const clamped = requested > SAFE_CEILING_MS;
  const readyPath = path.resolve(
    args.projectPath,
    "dist",
    "extension-js",
    browser,
    "ready.json",
  );

  const start = Date.now();
  const pollInterval = 1000;

  while (Date.now() - start < timeout) {
    try {
      const raw = fs.readFileSync(readyPath, "utf8");
      const contract: ReadyContract = JSON.parse(raw);

      if (contract.status === "ready") {
        return JSON.stringify({
          status: "ready",
          command: contract.command,
          browser: contract.browser,
          port: contract.port,
          pid: contract.pid,
          distPath: contract.distPath,
          manifestPath: contract.manifestPath,
          compiledAt: contract.compiledAt,
          startedAt: contract.startedAt,
          waitDuration: Date.now() - start,
        });
      }

      if (contract.status === "error") {
        return JSON.stringify({
          status: "error",
          message: contract.message,
          errors: contract.errors,
          code: contract.code,
          browser: contract.browser,
          waitDuration: Date.now() - start,
        });
      }
    } catch {
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return JSON.stringify({
    status: "timeout",
    message: `Extension not ready after ${timeout}ms this call`,
    readyPath,
    waitDuration: Date.now() - start,
    clamped: clamped
      ? `requested ${requested}ms was clamped to ${SAFE_CEILING_MS}ms to stay under the MCP client request timeout`
      : undefined,
    hint: "Still building — call extension_wait again to keep waiting (it resumes polling the same contract). If it never readies, check the dev process with extension_doctor.",
  });
}
