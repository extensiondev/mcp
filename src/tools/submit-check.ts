// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { runAskingOnly } from "../lib/ask-only";
import { SUBMIT_CHECK_ACTIONS, SUBMIT_CHECK_TOOL, answeredAs, submitCheckRefused } from "../lib/submit-action-safety";
import { handler as submitHandler, schema as submitSchema, type SubmitToolArgs } from "./submit";

import type { SubmitFacts } from "../lib/submit-facts";

const submitProperties = submitSchema.inputSchema.properties as Record<string, Record<string, unknown>>;

const SHARED = Object.keys(submitProperties).filter((key) => key !== "action" && key !== "approvalId" && key !== "dryRun");

const SHAPE_KEYS = ["type", "enum", "items", "default", "minimum"];

export const SHARED_INPUT_NOTE = "Same as in extension_submit.";

const sharedProperty = (key: string): Record<string, unknown> => ({
  ...Object.fromEntries(Object.entries(submitProperties[key]!).filter(([field]) => SHAPE_KEYS.includes(field))),
  description: SHARED_INPUT_NOTE,
});

export const schema = {
  name: SUBMIT_CHECK_TOOL,
  description:
    "Read a store's state or ask for an approval, with extension_submit's inputs: preflight, status and a dry-run submit answer here; any other action only asks the owner's approval and answers value.approvalUrl, and the call carrying that approvalId runs through extension_submit. It executes nothing.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [...SUBMIT_CHECK_ACTIONS],
        default: "submit",
        description: "preflight, status, submit (a dry run unless dryRun:false, which only asks approval), or a store act to ask approval for.",
      },
      dryRun: {
        type: "boolean",
        default: true,
        description: "true (the default) reads only; false only asks the owner's approval of the real submit.",
      },
      ...Object.fromEntries(SHARED.map((key) => [key, sharedProperty(key)])),
    },
    required: [],
  },
};

export async function handler(args: SubmitToolArgs, facts: SubmitFacts): Promise<string> {
  return submitCheckRefused(args as Record<string, unknown>) ?? answeredAs(await runAskingOnly(() => submitHandler(args, facts)), SUBMIT_CHECK_TOOL, submitSchema.name);
}
