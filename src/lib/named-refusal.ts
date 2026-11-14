// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export interface NamedRefusal {
  status: string;
  name: string;
  say: string;
  nextStep: { kind: "retry" | "approve"; say: string; url: null };
  hint: string;
}

function named(status: string, name: string, kind: "retry" | "approve", say: string, hint: string): NamedRefusal {
  return { status, name, say, nextStep: { kind, say, url: null }, hint };
}

/* @invariant A REFUSAL THAT SPENT NOTHING AND ASKS ONLY FOR ANOTHER TRY SAYS
 * SO BY NAME. The platform answers these codes when it could not read a
 * record of its own, or when the approver of a grant left the workspace:
 * nothing ran, nothing reached a store and no approval was used. Relayed
 * under the act's generic refusal they read like a refusal of the act
 * itself, and an approval the platform never used was called possibly
 * spent. Each one carries its own status, the sentence for the person and
 * the step that follows, the same on every tool that can receive it. A
 * submit is dispatched after the platform has answered, so a store run it
 * could not start (a build record it could not read, a run it could not
 * record, a lane that refused) never arrives as a code: it arrives as the
 * failed record's reason, in the platform's own never started sentence,
 * and that sentence is what the record's next step is read from.
 */
const NAMED: Record<string, NamedRefusal> = {
  UPLOAD_RUN_UNREAD: named(
    "upload-run-unread",
    "UploadRunUnread",
    "retry",
    "extension.dev could not read the run that carries this upload just now, so nothing was sent to review. Say publish again in a minute.",
    "The platform could not read the submit run that carries this draft's package, so it neither held nor sent the publish: nothing ran and no approval was requested or used. Make the same call again in a minute.",
  ),
  APPROVER_NOT_MEMBER: named(
    "approver-not-member",
    "ApproverNotMember",
    "approve",
    "Whoever approved this is no longer a member of the workspace, so the approval was not used and nothing ran. Say ask again and I request a fresh approval for a workspace member.",
    "The approval was given by someone who holds no role in the workspace now, so the platform did not use it and nothing ran. Call again without approvalId to request a fresh approval, then have a workspace member approve it.",
  ),
};

export function namedRefusalOf(code: unknown): NamedRefusal | undefined {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(NAMED, code) ? NAMED[code] : undefined;
}

const NEVER_STARTED = /could not start the \S+ store run\b[\s\S]*\bNothing ran for\b/i;

export function storeRunNeverStarted(reason: string): boolean {
  return NEVER_STARTED.test(reason);
}
