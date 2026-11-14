// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { readSubmitFacts } from "../lib/submit-facts-local";
import { handler as submitWithFacts, type SubmitToolArgs } from "./submit";

export { SUBMIT_ACTIONS, invalidArgumentsHint, schema, type SubmitToolArgs } from "./submit";

export async function handler(args: SubmitToolArgs): Promise<string> {
  return submitWithFacts(args, readSubmitFacts(args));
}
