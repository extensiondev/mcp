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
  name: "extension_builds_act",
  description: "Rebuild, recheck or configure builds on extension.dev, or create and configure a channel. Answers the act's outcome; extension_builds reads builds, extension_build and extension_analyze work on this machine. A rebuild spends allowance; a push, only on the build branch when it changes the root directory ([skip build] pushes, docs-only, other branches spend nothing).",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["rebuild", "recheck", "configure", "create-channel", "configure-channel", "delete-channel"],
        description: "rebuild; recheck: rerun integrity; configure: buildSettings; create-, configure-channel; delete-channel: console only.",
      },
      buildId: {
        type: "string",
        description: "Commit sha, never the build number. rebuild: the commit to build (default the branch head); required for recheck.",
      },
      buildEnv: {
        type: "string",
        enum: ["staging", "production"],
        description: "rebuild: staging (default, Preview) or production (Stable, stores).",
      },
      buildSettings: {
        type: "object",
        description: "configure: per-browser changes, e.g. { firefox: { buildCommand: 'pnpm build' } }.",
      },
      approvalId: {
        type: "string",
        description: "Approved approval id.",
      },
      channel: {
        type: "string",
        description: "Channel name, max 40 chars.",
      },
      description: {
        type: "string",
        description: "Channel description, max 200 chars.",
      },
      color: {
        type: "string",
        description: "Channel color, #rrggbb.",
      },
      audience: {
        type: "string",
        enum: ["public", "private"],
        description: "private, or public (owner approval); default the project's visibility.",
      },
      browser: {
        type: "string",
        description: "recheck: chrome, edge, firefox or safari (default all).",
      },
      projectPath: {
        type: "string",
        description: "Project directory; picks its login.",
      },
      project: PROJECT_TOKEN_INPUT,
      waitSeconds: ACT_WAIT_SECONDS,
      api: API_BASE,
    },
    required: ["action"],
  },
};

export const handler = hostedOnly(schema.name);
