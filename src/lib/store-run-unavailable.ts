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
import { isRow, text } from "./ship-act";
import { nextStep } from "./store-connection";

import type { CredentialRef } from "./credential-source";

type Row = Record<string, unknown>;

export const PLATFORM_UNAVAILABLE_STATUS = "platform-unavailable";
export const STORE_RUN_CHECK = "platform.store_run";
export const STORE_RUN_UNAVAILABLE_CODE = "STORE_RUN_UNAVAILABLE";
export const MIRRORS_FROZEN_CODE = "MIRRORS_FROZEN";
export const PLATFORM_UNAVAILABLE_SENTENCE =
  "The platform cannot take this store submission right now; nothing in your project causes it, and no approval will be asked until it can";

const MISSING_STORE_RUN = /\bstore\s+(?:submission\s+)?(?:run|workflow)\b|\bstore\.yml\b/i;

export interface StoreRunUnavailable {
  status: number;
  code: string;
  platformLine: string;
}

export function storeRunUnavailable(status: number, body: unknown): StoreRunUnavailable | null {
  const row = isRow(body) ? body : {};
  const code = text(row.code);
  const platformLine = text(row.message);

  if (status === 409 && (code === STORE_RUN_UNAVAILABLE_CODE || code === MIRRORS_FROZEN_CODE)) return { status, code, platformLine };
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
    message: `${PLATFORM_UNAVAILABLE_SENTENCE}. ${reportSentence(scope)}`,
    reportUrl: WRITE_FAILURE_REPORT_URL,
    platformLine: found.platformLine,
  };
}

export function platformUnavailableStep(scope: ReportScope) {
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
  const report = reportSentence(args);
  const say = `${PLATFORM_UNAVAILABLE_SENTENCE}.${approval.say ? ` ${approval.say}` : ""}`;

  return envelope({
    ok: false,
    command: args.command,
    status: PLATFORM_UNAVAILABLE_STATUS,
    error: {
      code: "E_PLATFORM",
      name: "PlatformUnavailable",
      message: `${PLATFORM_UNAVAILABLE_SENTENCE}. Nothing was sent to the store${beforeApproval ? " and no approval was asked for" : ""}.`,
      ...(args.found.code ? { platformCode: args.found.code } : {}),
    },
    value: {
      browsers: args.stores,
      buildSha: args.buildSha,
      dryRun: args.dryRun,
      owner: "platform",
      ...(beforeApproval ? { refusedBeforeApproval: true } : {}),
      ...(approval.refunded ? { approvalId: text(args.approvalId), approvalRefunded: approval.refunded } : {}),
      reportUrl: WRITE_FAILURE_REPORT_URL,
      platformLine: args.found.platformLine,
      sayToPerson: say,
      nextStep: platformUnavailableStep(args),
    },
    hint: `${say} ${report}`,
  });
}
