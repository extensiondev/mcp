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
 * write, never from a flag: a submission mode under which the next upload
 * leaves for the store's review and is published when it passes (ledger
 * 328, the same gate for the same consequence: chrome public or staged, edge
 * review and firefox listed, read per store from PUBLIC_SUBMISSION_MODES,
 * while edge draft, chrome draft-until-public and draft, firefox unlisted
 * and safari draft stay plain; safari review sits in that table under
 * ledger 324, because one version approval then also covers the publish act
 * that sends the TestFlight build to Apple's App Review, which an owner
 * cannot take back once Apple approves), a public
 * channel audience (asked at creation or set on an existing channel) and a
 * public project visibility, which opens every build the project ever made,
 * all keep the page; a channel delete is a person's act in the console, like
 * a project delete; a live channel whose recorded audience is public
 * resolves to the channel-audience row, since it changes what the
 * project's live link serves; a secret environment variable is a console
 * act under its own row. A listing sync is plain while every value in it is
 * the owner's own copy from STORE.md; a sync whose changes carry a value the
 * platform did not copy verbatim (the App Store subtitle the push takes from
 * the Summary when STORE.md has no `- Subtitle:` line) keeps the page through
 * the listing-derived row, because the owner never wrote that text. A Safari
 * submission mode of review (ledger 324) is the fourth audience exception:
 * under it one version approval also covers the publish act that sends the
 * TestFlight build to Apple's App Review, which cannot be taken back once
 * Apple approves, so the write is judged with its store and keeps the page.
 * The platform holds the same table in www src/services/registry/approval-policy.ts;
 * a row changed on one side is changed on both.
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
  "extension_settings.project": "plain",
  "extension_settings.environment": "plain",
  extension_submit: "approval",
  "extension_submit.version": "approval",
  "extension_store.publish": "approval",
  "extension_store.cancel": "approval",
  "extension_store.rollout": "approval",
  "extension_store.release": "approval",
  extension_release_promote: "approval",
  "extension_release.cut": "approval",
  "extension_release.rollback": "approval",
  "extension_shares.revoke": "approval",
  "extension_shares.public": "approval",
  "extension_builds.channel-audience": "approval",
  "extension_settings.store-public-mode": "approval",
  "extension_project.visibility-public": "approval",
  "extension_store.listing-derived": "approval",
  "extension_store.disconnect": "console",
  "extension_builds.delete-channel": "console",
  "extension_project.delete": "console",
  "extension_store.credentials": "console",
  "extension_settings.environment-secret": "console",
} as const satisfies Record<string, ApprovalVerdict>;

export type PolicyAct = keyof typeof APPROVAL_POLICY;

export const PUBLIC_SUBMISSION_MODES: Record<string, readonly string[]> = {
  chrome: ["public", "staged"],
  edge: ["review"],
  firefox: ["listed"],
  safari: ["review"],
};

export const PUBLIC_SUBMISSION_MODE_CONSEQUENCES: Record<string, string> = {
  "chrome.public": "Chrome public sends the next upload to Chrome's review, which publishes it to everyone the item's dashboard visibility allows when it passes.",
  "chrome.staged": "Chrome staged sends the next upload to Chrome's review, which publishes it to a share of the item's users when it passes; raising that share is its own approval.",
  "edge.review": "Edge review sends the next upload to certification, which publishes the extension to everyone when it passes.",
  "safari.review": "Safari review sends the next upload to App Store Connect as a TestFlight build and lets the version approval of that submit also cover the publish act that sends it to Apple's App Review; Apple's approval does not put it on sale, which stays its own approval.",
  "firefox.listed": "Firefox listed sends the next upload to AMO's listed review, which publishes the add-on on addons.mozilla.org to everyone when it passes.",
};

export interface PolicyWrite {
  store?: string;
  submissionMode?: string;
  releaseChannel?: string;
  audience?: string;
  visibility?: string;
  derived?: boolean;
}

const lower = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase() : "");

export function isPolicyAct(value: unknown): value is PolicyAct {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(APPROVAL_POLICY, value);
}

function publicModesOf(store: unknown): readonly string[] {
  const key = lower(store);

  return Object.prototype.hasOwnProperty.call(PUBLIC_SUBMISSION_MODES, key) ? (PUBLIC_SUBMISSION_MODES[key] ?? []) : Object.values(PUBLIC_SUBMISSION_MODES).flat();
}

function modeOf(write: PolicyWrite): string {
  return lower(write.releaseChannel) === "listed" ? "listed" : lower(write.submissionMode);
}

export function publicSubmissionMode(write: PolicyWrite): boolean {
  return publicModesOf(write.store).includes(lower(write.submissionMode)) || lower(write.releaseChannel) === "listed";
}

export function publicSubmissionModeConsequence(write: PolicyWrite): string {
  return PUBLIC_SUBMISSION_MODE_CONSEQUENCES[`${lower(write.store)}.${modeOf(write)}`] ?? "";
}

export function publicChannelAudience(write: PolicyWrite): boolean {
  return lower(write.audience) === "public";
}

export function publicProjectVisibility(write: PolicyWrite): boolean {
  return lower(write.visibility) === "public";
}

export function approvalVerdict(act: PolicyAct, write: PolicyWrite = {}): ApprovalVerdict {
  if (act === "extension_settings.store" && publicSubmissionMode(write)) return APPROVAL_POLICY["extension_settings.store-public-mode"];

  if ((act === "extension_builds.create-channel" || act === "extension_builds.configure-channel" || act === "extension_settings.project") && publicChannelAudience(write)) {
    return APPROVAL_POLICY["extension_builds.channel-audience"];
  }

  if (act === "extension_project.visibility" && publicProjectVisibility(write)) return APPROVAL_POLICY["extension_project.visibility-public"];

  if (act === "extension_store.listing" && write.derived === true) return APPROVAL_POLICY["extension_store.listing-derived"];

  return APPROVAL_POLICY[act];
}

export function verdictOfAction(action: string, write: PolicyWrite = {}): ApprovalVerdict {
  return isPolicyAct(action) ? approvalVerdict(action, write) : "approval";
}
