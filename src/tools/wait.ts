import fs from "node:fs";
import path from "node:path";
import type { ReadyContract } from "../lib/types";
import { resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_wait",
  description:
    "Wait for a running dev or start session to be ready. Polls the ready.json contract file and returns structured status.",
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
        default: 60000,
        description: "Timeout in milliseconds",
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
  const timeout = args.timeout ?? 60_000;
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
      // File doesn't exist yet or is being written — keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return JSON.stringify({
    status: "timeout",
    message: `Extension did not become ready within ${timeout}ms`,
    readyPath,
    hint: "The dev session may still be building. Try increasing the timeout, or check if the dev process is still running.",
  });
}
