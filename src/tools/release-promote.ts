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

export const schema = {
  name: "extension_release_promote",
  description: "Release a build to a channel on extension.dev. A release needs a workspace owner's token and approval of that exact release, every time (approval-required, then the same call with approvalId). Preview takes any build; Stable and every other channel take Stable builds. Tokens live 7 days.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["promote", "cut", "rollback"],
        default: "promote",
        description: "promote: channel to buildId; cut: version-bump pull request; rollback: previous build.",
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
      waitSeconds: {
        type: "number",
        description: "Seconds to wait for the result (with approvalId, the approval), 0 to 600 (default 180).",
      },
      api: API_BASE,
    },
    required: [],
  },
};

export const handler = hostedOnly(schema.name);
