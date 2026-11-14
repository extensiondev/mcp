// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { PROJECT_TOKEN_INPUT } from "../lib/credentials";
import { hostedOnly } from "../lib/hosted-only";
import { SYNC_CAPTURES, syncCaptures, type SyncCapturesArgs } from "./publish-captures";
import { PUBLISH_LOCAL } from "./publish-local";

export const schema = {
  name: "extension_publish",
  description: "Publish a build on extension.dev: the link for testers, with a download and a run command for each browser; use it first to share or ship (no project yet: extension_project_create). On a public project, or a public channel, send testers the channel link (<workspace>.extension.dev/<project>/<channel>); a private build link expires.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["publish", "sync-captures"],
        default: "publish",
        description: "publish: the link; sync-captures: captures/<browser>/*.png to build pages (approval).",
      },
      browsers: {
        type: "array",
        items: {
          type: "string",
          enum: ["chrome", "firefox", "edge", "safari"],
        },
        description: "sync-captures: browsers, one approval each.",
      },
      projectPath: {
        type: "string",
        description: "sync-captures: project root.",
      },
      approvalId: {
        type: "string",
        description: "Approved approval id.",
      },
      project: PROJECT_TOKEN_INPUT,
      ttlHours: {
        type: "number",
        description: "Private link lifetime, hours (default 168).",
      },
      buildSha: {
        type: "string",
        description: "Build sha, 7 to 40 hex (an unreadable index echoes the sha back unverified); not with channel.",
      },
      channel: {
        type: "string",
        description: "Link a channel's newest build instead.",
      },
      force: {
        type: "boolean",
        description: "Publish despite failed checks.",
      },
      waitSeconds: {
        type: "number",
        description: "Seconds to wait for the result (with approvalId, the approval), 0 to 600 (default 180).",
      },
      api: API_BASE,
    },
    required: [],
  },
};

export async function handler(args: SyncCapturesArgs & Record<string, unknown>): Promise<string> {
  if (args.action !== SYNC_CAPTURES) return hostedOnly(schema.name)(args);

  return syncCaptures(args, PUBLISH_LOCAL);
}
