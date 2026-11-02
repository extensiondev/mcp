// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { nextStep, type NextStep } from "./store-connection";

export function safariPublishSentence(args: { approvalId: string; statusRead: string }): string {
  const call = `call extension_submit action "publish" with browsers ["safari"]`;
  const read = args.statusRead ? ` (${args.statusRead} shows it)` : "";

  return args.approvalId
    ? `The App Store holds this build on TestFlight and nothing goes to App Review until the publish act sends it: once TestFlight holds the build${read}, ${call} and approvalId ${args.approvalId}, which spends the publish line of that approval and asks no second one.`
    : `The App Store holds this build on TestFlight and nothing goes to App Review until the publish act sends it: once TestFlight holds the build${read}, ${call}, which asks one more owner approval.`;
}

export function withSafariPublishStep(
  step: NextStep,
  args: { stores: string[]; approvalId: string; statusRead: string },
): NextStep {
  if (!args.stores.includes("safari")) return step;

  const safari = safariPublishSentence(args);
  const say = args.stores.length === 1 ? safari : `${step.say} ${safari}`;

  return nextStep("publish", say, step.url ?? undefined);
}
