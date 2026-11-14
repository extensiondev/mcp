// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";
import { platformApiGet, type ProjectApi } from "./project-api";
import { WRITE_FAILURE_REPORT_URL } from "./settings-write";
import { isRow, text } from "./row";
import { byHandFields, byHandSentence, offLaneHandOf, STORE_ACT_NOT_ON_LANE_CODE, type StoreActByHand } from "./store-act-by-hand";
import { nextStep } from "./store-connection";

import type { CredentialRef } from "./credential-source";

type Row = Record<string, unknown>;

export const PLATFORM_UNAVAILABLE_STATUS = "platform-unavailable";
export const STORE_RUN_CHECK = "platform.store_run";
export const MIRRORS_FROZEN_CODE = "MIRRORS_FROZEN";
export { STORE_ACT_NOT_ON_LANE_CODE };
export const PLATFORM_UNAVAILABLE_SENTENCE =
  "The platform cannot take this store submission right now; nothing in your project causes it, and no approval will be asked until it can";

const MISSING_STORE_RUN = /\bstore\s+(?:submission\s+)?(?:run|workflow)\b|\bstore\.yml\b/i;

export interface StoreRunUnavailable {
  status: number;
  code: string;
  platformLine: string;
  ownSentence?: string;
  hand?: StoreActByHand;
}

/* @invariant A STORE ACT THE PLATFORM NAMES AS NOT ON ITS LANE YET IS SAID IN
 * THE PLATFORM'S OWN SENTENCE. A 409 MIRRORS_FROZEN or STORE_ACT_NOT_ON_LANE
 * that names its store and act (a Safari submit while only Chrome, Edge and
 * Firefox run on the lane) is not an outage to report: the platform says
 * which store to leave out or the store's own hand path, and that sentence
 * is what the person reads (ledger 567). Every other platform fault keeps
 * the generic report sentence.
 */
export function storeRunUnavailable(status: number, body: unknown): StoreRunUnavailable | null {
  const row = isRow(body) ? body : {};
  const code = text(row.code);
  const platformLine = text(row.message);
  const actRefusal = code === MIRRORS_FROZEN_CODE || code === STORE_ACT_NOT_ON_LANE_CODE;
  const hand = status === 409 ? offLaneHandOf(code, row) : null;
  const own = hand ? { ownSentence: byHandSentence(platformLine, hand), hand } : actRefusal && text(row.act) && platformLine ? { ownSentence: platformLine } : {};

  if (status === 409 && actRefusal) return { status, code, platformLine, ...own };
  if (status === 404 && MISSING_STORE_RUN.test(platformLine)) return { status, code, platformLine };

  return null;
}

export interface DryRunStoreRead {
  fault: StoreRunUnavailable | null;
  body: Row | null;
}

export async function dryRunStoreRead(
  api: Pick<ProjectApi, "base" | "token" | "command"> & { ref?: CredentialRef | null },
  browsers: string[],
  buildSha: string,
): Promise<DryRunStoreRead> {
  if (!buildSha || !browsers.length) return { fault: null, body: null };

  const read = await platformApiGet<Row>(api, "/api/cli/stores/submit", undefined, { method: "POST", body: { browsers, buildSha, dryRun: true } }).catch(() => null);
  if (!read) return { fault: null, body: null };
  if (read.ok) return { fault: null, body: isRow(read.json) ? read.json : null };

  return { fault: storeRunUnavailable(read.status, read.body), body: null };
}

export async function dryRunStoreRun(
  api: Pick<ProjectApi, "base" | "token" | "command"> & { ref?: CredentialRef | null },
  browsers: string[],
  buildSha: string,
): Promise<StoreRunUnavailable | null> {
  return (await dryRunStoreRead(api, browsers, buildSha)).fault;
}

export interface ReportScope {
  ref: CredentialRef | null | undefined;
  stores: string[];
  buildSha: string;
  ownSentence?: string;
  hand?: StoreActByHand;
}

export function reportSentence(scope: ReportScope): string {
  const project = scope.ref ? `${scope.ref.workspace}/${scope.ref.project}` : "the project";
  const stores = scope.stores.length > 1 ? `the stores ${scope.stores.join(", ")}` : `the store ${scope.stores[0] ?? "asked"}`;

  return `Report it at ${WRITE_FAILURE_REPORT_URL} with the project ${project}, ${stores} and build ${scope.buildSha || "unknown"}.`;
}

export function storeRunCheck(found: StoreRunUnavailable, scope: ReportScope): Row {
  return {
    id: STORE_RUN_CHECK,
    label: "The platform can take this store's submission",
    status: "fail",
    severity: "blocking",
    stage: "integration",
    owner: "platform",
    expected: "the submit route's dry run takes the store",
    actual: `the dry run answered ${found.status}${found.code ? ` ${found.code}` : ""}`,
    message: found.ownSentence ?? `${PLATFORM_UNAVAILABLE_SENTENCE}. ${reportSentence(scope)}`,
    ...(found.ownSentence ? {} : { reportUrl: WRITE_FAILURE_REPORT_URL }),
    platformLine: found.platformLine,
  };
}

export function platformUnavailableStep(scope: ReportScope) {
  if (scope.ownSentence && scope.hand) return byHandFields(scope.ownSentence, scope.hand).nextStep;
  if (scope.ownSentence) return nextStep("watch", scope.ownSentence);

  return nextStep("watch", `${PLATFORM_UNAVAILABLE_SENTENCE}. ${reportSentence(scope)}`, WRITE_FAILURE_REPORT_URL);
}

export interface PlatformUnavailableAnswer extends ReportScope {
  command: string;
  found: StoreRunUnavailable;
  dryRun: boolean;
  approvalId?: string;
  refundSaid?: unknown;
}

function approvalSentence(args: PlatformUnavailableAnswer): { say: string; refunded?: true | "unknown" } {
  if (args.dryRun) return { say: "" };

  const approvalId = text(args.approvalId);
  if (!approvalId) return { say: "No approval was asked for." };

  if (args.refundSaid === true) {
    return { say: `The platform says approval ${approvalId} was not spent, so once it can take the submission, call again with the same arguments and that approvalId.`, refunded: true };
  }

  return {
    say: `The platform did not say whether approval ${approvalId} was given back: read extension_approvals (action: status, approvalId: ${approvalId}), or the approvals list in the console, before asking for another.`,
    refunded: "unknown",
  };
}

export function platformUnavailableAnswer(args: PlatformUnavailableAnswer): string {
  const beforeApproval = !args.dryRun && !text(args.approvalId);
  const approval = approvalSentence(args);
  const own = args.found.ownSentence;
  const report = own ? "" : reportSentence(args);
  const say = own ?? `${PLATFORM_UNAVAILABLE_SENTENCE}.${approval.say ? ` ${approval.say}` : ""}`;

  return envelope({
    ok: false,
    command: args.command,
    status: PLATFORM_UNAVAILABLE_STATUS,
    error: {
      code: "E_PLATFORM",
      name: "PlatformUnavailable",
      message: own ?? `${PLATFORM_UNAVAILABLE_SENTENCE}. Nothing was sent to the store${beforeApproval ? " and no approval was asked for" : ""}.`,
      ...(args.found.code ? { platformCode: args.found.code } : {}),
    },
    value: {
      browsers: args.stores,
      buildSha: args.buildSha,
      dryRun: args.dryRun,
      owner: "platform",
      ...(beforeApproval ? { refusedBeforeApproval: true } : {}),
      ...(approval.refunded ? { approvalId: text(args.approvalId), approvalRefunded: approval.refunded } : {}),
      ...(own ? {} : { reportUrl: WRITE_FAILURE_REPORT_URL }),
      platformLine: args.found.platformLine,
      sayToPerson: say,
      nextStep: platformUnavailableStep({ ...args, ...(own ? { ownSentence: own } : {}), ...(args.found.hand ? { hand: args.found.hand } : {}) }),
      ...(own && args.found.hand ? byHandFields(own, args.found.hand) : {}),
    },
    hint: report ? `${say} ${report}` : say,
  });
}
