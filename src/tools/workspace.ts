// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { CONFIRM_INPUT } from "../lib/bulk-delete";
import { hostedOnly } from "../lib/hosted-only";

export const schema = {
  name: "extension_workspace",
  description: "Read the workspace (projects, usage, settings) or change a project's settings. configure-project renames a project (displayName; slug and URLs stay). set-visibility public or a public liveChannel needs approval. Builds spend only on build branch pushes that change the root directory. extension_auth_login: logins; extension_approvals_read lists approvals.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["info", "projects", "usage", "settings", "set-visibility", "configure-project", "set-environment"],
        default: "info",
        description: "set-* and configure-project write.",
      },
      visibility: {
        type: "string",
        enum: ["private", "public"],
        description: "private: plain call under the owner's own token; public: approve page.",
      },
      settings: {
        type: "object",
        description: "configure-project: changed fields only (displayName, description, url, supportUrl, branch, rootDirectory, workspaceRoot, buildPullRequests, runWhatsNew, runExtensionExecutables, pullRequestComments, commitComments, autoCreateGitHubRelease, liveChannel); displayName renames the project.",
      },
      variables: {
        type: "array",
        description: "set-environment: build variables to add or change.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Name.",
            },
            value: {
              type: "string",
              description: "Plain value.",
            },
            scope: {
              type: "string",
              enum: ["all", "production", "staging"],
              description: "Scope.",
            },
            note: {
              type: "string",
              description: "Note.",
            },
            secret: {
              type: "boolean",
              description: "Must be false.",
            },
          },
          required: ["name", "value"],
        },
      },
      remove: {
        type: "array",
        description: "set-environment: build variables to delete; more than one takes confirm.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Name.",
            },
            scope: {
              type: "string",
              enum: ["all", "production", "staging"],
              description: "Scope.",
            },
          },
          required: ["name"],
        },
      },
      confirm: CONFIRM_INPUT,
      approvalId: {
        type: "string",
        description: "For set-visibility public.",
      },
      include: {
        type: "array",
        items: {
          type: "string",
          enum: ["team", "members", "tokens", "apps", "activity", "environment", "storeAccounts"],
        },
        description: "Extra read-only sections to answer with the workspace.",
      },
      workspace: {
        type: "string",
        description: "Slug.",
      },
      project: {
        type: "string",
        description: "Stored login; for settings, the project.",
      },
      api: API_BASE,
    },
    required: [],
  },
};

export const handler = hostedOnly(schema.name);
