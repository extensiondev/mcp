// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ACT_WAIT_SECONDS, API_BASE } from "../lib/common-schema";
import { PROJECT_TOKEN_INPUT } from "../lib/credentials";
import { hostedOnly } from "../lib/hosted-only";
import { SYNC_CAPTURES, syncCaptures, type SyncCapturesArgs } from "./publish-captures";
import { PUBLISH_LOCAL } from "./publish-local";

export const schema = {
  name: "extension_publish",
  description: "Publish and share a build through extension.dev: answers the tester link, a page with a download and a run command for each browser (no project yet: extension_project_create). extension_preview_web: emulator links; extension_shares_manage revokes. On a public project, or a public channel, send testers the channel link the answer gives; a private build link expires.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["publish", "sync-captures"],
        default: "publish",
        description: "publish: the link; sync-captures: captures/<browser>/*.png, else STORE.md screenshots, to build pages (approval).",
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
      waitSeconds: ACT_WAIT_SECONDS,
      api: API_BASE,
    },
    required: [],
  },
};

export async function handler(args: SyncCapturesArgs & Record<string, unknown>): Promise<string> {
  if (args.action !== SYNC_CAPTURES) return hostedOnly(schema.name)(args);

  return syncCaptures(args, PUBLISH_LOCAL);
}
