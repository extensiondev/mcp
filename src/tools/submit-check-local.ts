// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { readSubmitFacts } from "../lib/submit-facts-local";
import { handler as checkWithFacts } from "./submit-check";

import type { SubmitToolArgs } from "./submit";

export { SHARED_INPUT_NOTE, schema } from "./submit-check";

export async function handler(args: SubmitToolArgs): Promise<string> {
  return checkWithFacts(args, readSubmitFacts(args));
}
