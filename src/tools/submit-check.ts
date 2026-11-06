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

const submitProperties = submitSchema.inputSchema.properties as Record<string, Record<string, unknown>>;

const SHARED = Object.keys(submitProperties).filter((key) => key !== "action" && key !== "approvalId");

const STORE_SETTINGS = {
  type: "object",
  description: "With configure-store, only what changes for store, the same keys extension_submit's storeSettings lists.",
};

const SHORTER: Record<string, string> = {
  dryRun: "true (the default) reads only; false only asks the owner's approval of the real submit.",
  screenshots: "With sync-listing, PNGs in projectPath, at the sizes extension_submit lists.",
  detail: "With preflight, true or a list of stores and requirement ids answers those rows in full.",
};

const sharedProperty = (key: string): Record<string, unknown> => {
  if (key === "storeSettings") return STORE_SETTINGS;

  const property = submitProperties[key]!;

  return SHORTER[key] ? { ...property, description: SHORTER[key] } : property;
};

export const schema = {
  name: SUBMIT_CHECK_TOOL,
  description:
    "Read a store submission or ask for an approval, under a read-only hint; it executes nothing. A real submit or store act first answers approval-required with value.approvalUrl here; the call carrying the approvalId runs through extension_submit.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [...SUBMIT_CHECK_ACTIONS],
        default: "submit",
        description:
          "preflight, status, or submit (default; a dry run unless dryRun:false, which only asks approval); publish, review, cancel, rollout, release, sync-listing, configure-store only ask approval.",
      },
      ...Object.fromEntries(SHARED.map((key) => [key, sharedProperty(key)])),
    },
    required: [],
  },
};

export async function handler(args: SubmitToolArgs): Promise<string> {
  return submitCheckRefused(args as Record<string, unknown>) ?? answeredAs(await runAskingOnly(() => submitHandler(args)), SUBMIT_CHECK_TOOL, submitSchema.name);
}
