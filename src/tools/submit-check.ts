// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { SUBMIT_CHECK_ACTIONS, SUBMIT_CHECK_TOOL, submitCheckRefused } from "../lib/submit-action-safety";
import { handler as submitHandler, schema as submitSchema, type SubmitToolArgs } from "./submit";

const SHARED = ["project", "browsers", "buildSha", "version", "dryRun", "projectPath", "detail", "waitSeconds", "api"] as const;

const submitProperties = submitSchema.inputSchema.properties as Record<string, Record<string, unknown>>;

export const schema = {
  name: SUBMIT_CHECK_TOOL,
  description:
    "Read a store submission's readiness through extension_submit's own handler, under a read-only hint: preflight reads each store's readiness, status each store's own state, and submit with dryRun true (the default) rehearses; none dispatches anything. submit with dryRun:false and no approvalId only asks a workspace owner to approve the exact submission on extension.dev (approval-required, value.approvalUrl) and executes nothing. Use extension_submit for the call carrying the approved approvalId and for every other action; this tool refuses those before anything is sent.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [...SUBMIT_CHECK_ACTIONS],
        default: "submit",
        description:
          "preflight, status, or submit (the default): a dry run unless dryRun is false, which only asks for the owner's approval. Each answers as extension_submit answers the same action.",
      },
      ...Object.fromEntries(SHARED.map((key) => [key, submitProperties[key]])),
    },
    required: [],
  },
};

export async function handler(args: SubmitToolArgs): Promise<string> {
  return submitCheckRefused(args as Record<string, unknown>) ?? submitHandler(args);
}
