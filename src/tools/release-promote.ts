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

export const schema = {
  name: "extension_release_promote",
  description: "Release a build to a channel on extension.dev, cut a version-bump pull request, or roll a channel back. Each needs a workspace owner's approval of that exact act every time, asked with extension_approvals_request. Preview takes any build; Stable and every other channel take Stable builds. Tokens live 7 days. Stores are extension_submit; extension_release_status answers where things stand.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["promote", "cut", "rollback", "notes"],
        default: "promote",
        description: "promote: channel to buildId; cut: version-bump pull request; rollback: previous build; notes: replace a channel's releaseNotes.",
      },
      project: PROJECT_TOKEN_INPUT,
      buildId: {
        type: "string",
        description: "Build commit sha (7+ characters).",
      },
      channel: {
        type: "string",
        description: "Target channel, e.g. stable, preview.",
      },
      level: {
        type: "string",
        enum: ["patch", "minor", "major"],
        description: "cut: version bump (default patch).",
      },
      sourceChannel: {
        type: "string",
        description: "Channel to promote from (inferred).",
      },
      browsers: {
        type: "array",
        items: {
          type: "string",
        },
        description: "Browsers; default the build's index, which falls back to chrome alone.",
      },
      version: {
        type: "string",
        description: "Version label; cut: the exact version.",
      },
      releaseNotes: {
        type: "string",
        description: "Release notes, markdown.",
      },
      approvalId: {
        type: "string",
        description: "Approved approval id; every release needs a workspace owner's approval.",
      },
      waitSeconds: ACT_WAIT_SECONDS,
      api: API_BASE,
    },
    required: [],
  },
};

export const handler = hostedOnly(schema.name);
