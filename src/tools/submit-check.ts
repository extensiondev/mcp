// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { hostedOnly } from "../lib/hosted-only";

export const schema = {
  name: "extension_submit_check",
  description: "Check a store submission without sending it: preflight, status and a dry-run submit answer here; any other action records an approval request for the workspace owner and answers value.approvalUrl. extension_submit runs the call carrying that approvalId; extension_release_status answers review history, extension_release_promote releases a channel. Takes extension_submit's inputs.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [
          "preflight",
          "status",
          "submit",
          "publish",
          "review",
          "cancel",
          "rollout",
          "release",
          "sync-listing",
          "mint-signing",
          "configure-store",
          "connect",
          "first-submission",
        ],
        default: "submit",
        description: "The read, or the act to ask approval for.",
      },
      dryRun: {
        type: "boolean",
        default: true,
        description: "true reads only; false only asks the owner's approval of the real submit.",
      },
      project: {
        type: "string",
        description: "As in extension_submit.",
      },
      workspace: {
        type: "string",
        description: "As in extension_submit.",
      },
      browsers: {
        type: "array",
        items: {
          type: "string",
          enum: ["chrome", "firefox", "edge", "safari"],
        },
        description: "As in extension_submit.",
      },
      buildSha: {
        type: "string",
        description: "As in extension_submit.",
      },
      version: {
        type: "string",
        description: "As in extension_submit.",
      },
      projectPath: {
        type: "string",
        description: "As in extension_submit.",
      },
      screenshots: {
        type: "array",
        items: {
          type: "string",
        },
        description: "As in extension_submit.",
      },
      useBuild: {
        type: "string",
        description: "As in extension_submit.",
      },
      detail: {
        type: ["boolean", "array"],
        items: {
          type: "string",
        },
        description: "As in extension_submit.",
      },
      api: {
        type: "string",
        description: "As in extension_submit.",
      },
      store: {
        type: "string",
        enum: ["chrome", "firefox", "edge", "safari"],
        description: "As in extension_submit.",
      },
      storeSettings: {
        type: "object",
        description: "As in extension_submit.",
      },
      submissionId: {
        type: "string",
        description: "As in extension_submit.",
      },
      buildNumber: {
        type: "integer",
        minimum: 1,
        description: "As in extension_submit.",
      },
      deployPercentage: {
        type: "number",
        description: "As in extension_submit.",
      },
      connectSession: {
        type: "string",
        description: "As in extension_submit.",
      },
      replace: {
        type: "boolean",
        description: "As in extension_submit.",
      },
      waitSeconds: {
        type: "number",
        description: "As in extension_submit.",
      },
    },
    required: [],
  },
};

export const SHARED_INPUT_NOTE = "As in extension_submit.";

export const handler = hostedOnly(schema.name);
