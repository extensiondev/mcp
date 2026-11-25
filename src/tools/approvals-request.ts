// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { APPROVALS_REQUEST_TOOL, REQUESTABLE_TOOLS } from "../lib/approvals-request";
import { hostedOnly } from "../lib/hosted-only";

export const schema = {
  name: APPROVALS_REQUEST_TOOL,
  description: "Request a workspace owner's approval of one act on extension.dev: a store submit, a release, a public visibility or channel, a slug rename or a share revoke. Nothing runs until the owner approves it. Answers value.approvalId, value.approvalUrl and value.runWhenApproved, the call to make once approved; extension_submit and extension_release_promote run acts, extension_release_status reads.",
  inputSchema: {
    type: "object" as const,
    properties: {
      act: {
        type: "string",
        enum: [...REQUESTABLE_TOOLS],
        description: "The tool that runs the act once approved.",
      },
      args: {
        type: "object",
        description: "That tool's arguments for the act, without approvalId.",
      },
    },
    required: ["act", "args"],
  },
};

export const handler = hostedOnly(schema.name);
