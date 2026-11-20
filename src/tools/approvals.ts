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
  description: "List the open approvals this login asked for, read one, or revoke one approved by mistake (owner token) on extension.dev.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["list", "status", "revoke"],
        description: "List (the default with no approvalId), read or revoke.",
      },
      approvalId: {
        type: "string",
        description: "The apr_ id; status and revoke need it.",
      },
      project: PROJECT_TOKEN_INPUT,
      api: API_BASE,
    },
  },
};

export const handler = hostedOnly(schema.name);
