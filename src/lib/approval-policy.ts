// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export type ApprovalVerdict = "plain" | "approval" | "console";

/* @invariant THE APPROVAL LINE IS ONE TABLE KEYED BY ACT, AND EVERY TOOL ASKS
 * IT BEFORE AN APPROVAL IS MINTED. Cezar's ruling of 2026-10-23 (ledger 143,
 * closing 137 and 139) moves the line to Vercel's shape: a reversible setting
 * is a plain tool call under the owner's own token, with the MCP client's
 * permission prompt as its only gate, and the platform's approve page stays
 * for the acts that leave a mark outside extension.dev. "plain" acts never
 * mint on their own; the platform may still ask for one (an audience change
 * it computed from the stored state), and that request is honored.
 * "approval" acts mint before they run. "console" acts never reach the
 * platform from here. The three audience exceptions are computed from the
 * write, never from a flag: a listed or public submission mode, a public
 * channel audience (asked at creation or set on an existing channel) and a
 * public project visibility, which opens every build the project ever made,
 * all keep the page; a channel delete is a person's act in the console, like
 * a project delete. The platform holds the same table in
 * www src/services/registry/approval-policy.ts; a row changed on one side is
 * changed on both.
 */
export const APPROVAL_POLICY = {
  "extension_settings.build": "plain",
  "extension_settings.store": "plain",
  "extension_store.listing": "plain",
  "extension_builds.rebuild": "plain",
  "extension_builds.recheck": "plain",
  "extension_builds.create-channel": "plain",
  "extension_builds.configure-channel": "plain",
  "extension_project.visibility": "plain",
  extension_submit: "approval",
  "extension_store.publish": "approval",
  "extension_store.cancel": "approval",
  "extension_store.rollout": "approval",
  extension_release_promote: "approval",
  "extension_release.cut": "approval",
  "extension_release.rollback": "approval",
  "extension_shares.revoke": "approval",
  "extension_shares.public": "approval",
  "extension_builds.channel-audience": "approval",
  "extension_settings.store-public-mode": "approval",
  "extension_project.visibility-public": "approval",
  "extension_store.disconnect": "console",
  "extension_builds.delete-channel": "console",
  "extension_project.delete": "console",
  "extension_store.credentials": "console",
} as const satisfies Record<string, ApprovalVerdict>;

export type PolicyAct = keyof typeof APPROVAL_POLICY;

export const PUBLIC_SUBMISSION_MODES = ["listed", "public"] as const;

export interface PolicyWrite {
  submissionMode?: string;
  releaseChannel?: string;
  audience?: string;
  visibility?: string;
}

const lower = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase() : "");

export function isPolicyAct(value: unknown): value is PolicyAct {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(APPROVAL_POLICY, value);
}

export function publicSubmissionMode(write: PolicyWrite): boolean {
  return (PUBLIC_SUBMISSION_MODES as readonly string[]).includes(lower(write.submissionMode)) || lower(write.releaseChannel) === "listed";
}

export function publicChannelAudience(write: PolicyWrite): boolean {
  return lower(write.audience) === "public";
}

export function publicProjectVisibility(write: PolicyWrite): boolean {
  return lower(write.visibility) === "public";
}

export function approvalVerdict(act: PolicyAct, write: PolicyWrite = {}): ApprovalVerdict {
  if (act === "extension_settings.store" && publicSubmissionMode(write)) return APPROVAL_POLICY["extension_settings.store-public-mode"];

  if ((act === "extension_builds.create-channel" || act === "extension_builds.configure-channel") && publicChannelAudience(write)) {
    return APPROVAL_POLICY["extension_builds.channel-audience"];
  }

  if (act === "extension_project.visibility" && publicProjectVisibility(write)) return APPROVAL_POLICY["extension_project.visibility-public"];

  return APPROVAL_POLICY[act];
}

export function verdictOfAction(action: string, write: PolicyWrite = {}): ApprovalVerdict {
  return isPolicyAct(action) ? approvalVerdict(action, write) : "approval";
}
