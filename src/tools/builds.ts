// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE, waitSecondsInput } from "../lib/common-schema";
import { PROJECT_TOKEN_INPUT } from "../lib/credentials";
import { movedActHint } from "../lib/builds-split";
import { hostedOnly } from "../lib/hosted-only";
import { DOWNLOAD_ACTION, download, type DownloadArgs } from "./builds-download";
import { BUILDS_DOWNLOAD_LOCAL } from "./builds-download-local";

import type { InputIssue } from "../lib/validate-input";

export const schema = {
  name: "extension_builds",
  description: "Read and download platform builds. list/get rows: env is the build environment, channels the pins holding it now. To rebuild, recheck or configure, call extension_builds_act.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "logs", "download"],
        default: "list",
        description: "list: recent builds, lastPush; get: one build; logs; download: a verified package.",
      },
      buildId: {
        type: "string",
        description: "Commit sha, never the build number; required for get, logs, download.",
      },
      browser: {
        type: "string",
        description: "chrome, edge, firefox, safari; download requires it and takes source.",
      },
      projectPath: {
        type: "string",
        description: "Project directory; picks its login.",
      },
      to: {
        type: "string",
        description: "download: directory (default the cache).",
      },
      limit: {
        type: "number",
        description: "list: 1 to 50 (default 10).",
      },
      project: PROJECT_TOKEN_INPUT,
      waitSeconds: waitSecondsInput("get: seconds to wait for a build's verdict (a rebuild or a push)", "0"),
      api: API_BASE,
    },
    required: [],
  },
};

export function invalidArgumentsHint(issues: InputIssue[], args: Record<string, unknown>): string | undefined {
  return issues.some((issue) => issue.path === "action") ? movedActHint(args.action) : undefined;
}

export async function handler(args: DownloadArgs & Record<string, unknown>): Promise<string> {
  if (args.action !== DOWNLOAD_ACTION) return hostedOnly(schema.name)(args);

  return download(args, BUILDS_DOWNLOAD_LOCAL);
}
