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
  name: "extension_approvals",
  description: "Read or revoke one approval on extension.dev; revoke a pending or unused one approved by mistake (owner token).",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["status", "revoke"],
        default: "status",
        description: "Read or revoke.",
      },
      approvalId: {
        type: "string",
        description: "The apr_ id.",
      },
      project: PROJECT_TOKEN_INPUT,
      api: API_BASE,
    },
    required: ["approvalId"],
  },
};

export const handler = hostedOnly(schema.name);
