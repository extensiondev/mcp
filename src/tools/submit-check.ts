// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { runAskingOnly } from "../lib/ask-only";
import { SUBMIT_CHECK_ACTIONS, SUBMIT_CHECK_TOOL, submitCheckRefused } from "../lib/submit-action-safety";
import { handler as submitHandler, schema as submitSchema, type SubmitToolArgs } from "./submit";

const submitProperties = submitSchema.inputSchema.properties as Record<string, Record<string, unknown>>;

const SHARED = Object.keys(submitProperties).filter((key) => key !== "action" && key !== "approvalId");

export const schema = {
  name: SUBMIT_CHECK_TOOL,
  description:
    "Read a store submission and ask for an approval through extension_submit's own handler, under a read-only hint. preflight, status and submit with dryRun true (the default) dispatch nothing. Every first call with no approvalId that only asks a workspace owner to approve an exact act (approval-required, value.approvalUrl) comes here and executes nothing: submit with dryRun:false, publish, cancel, rollout, release, a derived sync-listing, a public configure-store. The call carrying the approvalId, and a plain sync-listing or configure-store, run through extension_submit; this tool refuses them.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [...SUBMIT_CHECK_ACTIONS],
        default: "submit",
        description:
          "preflight, status, or submit (the default): a dry run unless dryRun is false, which only asks for the owner's approval; publish, review, cancel, rollout, release, sync-listing and configure-store only ask for the approval of that act, with the same arguments extension_submit takes for it. Each answers as extension_submit answers the same call.",
      },
      ...Object.fromEntries(SHARED.map((key) => [key, submitProperties[key]])),
    },
    required: [],
  },
};

export async function handler(args: SubmitToolArgs): Promise<string> {
  return submitCheckRefused(args as Record<string, unknown>) ?? runAskingOnly(() => submitHandler(args));
}
