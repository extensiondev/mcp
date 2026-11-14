// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";
import { isRow, text } from "./row";
import { nextStep } from "./store-connection";
import { storeRunUnavailable } from "./store-run-unavailable";
import { storeName } from "./store-upload-words";
import { trackUrl as consoleTrackUrl } from "./track-url";

import type { CredentialRef } from "./credential-source";

type Row = Record<string, unknown>;

export const STORE_REFUSED_INSTALL_STATUS = "store-refused-install";
export const STORE_REFUSED_INSTALL_CODE = "STORE_REFUSED_INSTALL";
export const INSTALL_REFUSAL =
  /\b(?:could not be installed|cannot be installed|can't be installed|failed to install|fails to install|installation (?:test|check|failed|error)|install test|not installable)\b/i;

export const INSTALL_FILES_HINT =
  "Check the manifest and every file it names: the service worker, the content scripts, the pages, the icons and the locale files must be in the built package at the paths the manifest gives (a manifest naming a service worker file that is not in the package is the usual cause). Loading the unpacked build in a browser shows the same error. Fix it, build again and submit the new build.";

export interface StoreRefusedInstall {
  status: number;
  code: string;
  store: string;
  platformLine: string;
}

export function installRefusalLine(lines: unknown[]): string | null {
  return lines.map((line) => text(line)).find((line) => INSTALL_REFUSAL.test(line)) ?? null;
}

export function storeRefusedInstall(status: number, body: unknown): StoreRefusedInstall | null {
  if (status < 400 || status >= 500) return null;
  if (storeRunUnavailable(status, body)) return null;

  const row = isRow(body) ? body : {};
  const code = text(row.code);
  const upload = isRow(row.storeUpload) ? row.storeUpload : {};
  const platformLine = installRefusalLine([row.message, row.reason, row.detail, row.storeMessage, upload.message]) ?? (code === STORE_REFUSED_INSTALL_CODE ? text(row.message) : null);

  if (platformLine === null) return null;

  return { status, code, store: text(row.store), platformLine };
}

export function installRefusedSentence(store: string, platformLine: string): string {
  const reason = platformLine.trim().replace(/[.\s]+$/, "");

  return `${storeName(store)} refused the upload because the package could not be installed${reason ? `; the store's reason: "${reason}"` : ""}.`;
}

export function installRefusedSay(store: string, platformLine: string): string {
  return `${installRefusedSentence(store, platformLine)} ${INSTALL_FILES_HINT}`;
}

function approvalSentence(approvalId: string, refundSaid: unknown): { say: string; refunded?: true | "unknown" } {
  if (!approvalId) return { say: "No approval was asked for." };
  if (refundSaid === true) return { say: `The platform says approval ${approvalId} was not spent, so once the package installs, call again with the new build and a fresh approval.`, refunded: true };

  return {
    say: `The platform did not say whether approval ${approvalId} was given back: read extension_approvals (action: status, approvalId: ${approvalId}), or the approvals list in the console, before asking for another.`,
    refunded: "unknown",
  };
}

export interface InstallRefusedAnswer {
  command: string;
  found: StoreRefusedInstall;
  dryRun: boolean;
  ref: CredentialRef | null | undefined;
  stores: string[];
  buildSha: string;
  approvalId?: string;
  refundSaid?: unknown;
  api?: string;
}

function buildPage(ref: CredentialRef | null | undefined, buildSha: string, store: string, api?: string): string {
  return consoleTrackUrl("build", { ...(ref ? { workspace: ref.workspace, project: ref.project } : {}), buildId: buildSha, browser: store }, api);
}

export function installRefusedAnswer(args: InstallRefusedAnswer): string {
  const store = args.found.store || args.stores[0] || "chrome";
  const trackUrl = buildPage(args.ref, args.buildSha, store, args.api);
  const approval = args.dryRun ? { say: "" } : approvalSentence(text(args.approvalId), args.refundSaid);
  const say = installRefusedSay(store, args.found.platformLine);

  return envelope({
    ok: false,
    command: args.command,
    status: STORE_REFUSED_INSTALL_STATUS,
    error: {
      code: "E_MANIFEST_BLOCKING",
      name: "StoreRefusedInstall",
      message: `${storeName(store)} refused the package because it could not be installed, so nothing was submitted by this call.`,
      ...(args.found.code ? { platformCode: args.found.code } : {}),
    },
    value: {
      browsers: args.stores,
      buildSha: args.buildSha,
      dryRun: args.dryRun,
      store,
      owner: "you",
      ...(approval.refunded ? { approvalId: text(args.approvalId), approvalRefunded: approval.refunded } : {}),
      trackUrl,
      platformLine: args.found.platformLine,
      sayToPerson: say,
      nextStep: nextStep("resubmit", say, trackUrl),
    },
    hint: `${say}${approval.say ? ` ${approval.say}` : ""}`,
  });
}

export interface InstallRefusedRecord {
  store: string;
  platformLine: string;
}

export function installRefusedRecords(stores: string[], record: Record<string, unknown> | null | undefined): InstallRefusedRecord[] | null {
  const rows = stores.map((store) => {
    const row = isRow(record?.[store]) ? (record![store] as Row) : {};
    const upload = isRow(row.storeUpload) ? row.storeUpload : {};
    const read = isRow(row.statusRead) ? row.statusRead : {};
    const platformLine = installRefusalLine([row.failureReason, upload.message, read.note]);

    return platformLine === null ? null : { store, platformLine };
  });

  return rows.length && rows.every((row) => row !== null) ? (rows as InstallRefusedRecord[]) : null;
}

export interface InstallRefusedAfterRun {
  command: string;
  refusals: InstallRefusedRecord[];
  result: Row;
  ref: CredentialRef | null | undefined;
  buildSha: string;
  statusRead: string;
  warnings: Array<string | null | undefined | false>;
  api?: string;
}

export function installRefusedAfterRun(args: InstallRefusedAfterRun): string {
  const first = args.refusals[0]!;
  const trackUrl = buildPage(args.ref, args.buildSha, first.store, args.api);
  const say = `${args.refusals.map((row) => installRefusedSentence(row.store, row.platformLine)).join(" ")} ${INSTALL_FILES_HINT}`;

  return envelope({
    ok: false,
    command: args.command,
    status: STORE_REFUSED_INSTALL_STATUS,
    error: {
      code: "E_MANIFEST_BLOCKING",
      name: "StoreRefusedInstall",
      message: `The platform's record says ${args.refusals.map((row) => storeName(row.store)).join(", ")} refused the package because it could not be installed.`,
    },
    value: {
      ...args.result,
      owner: "you",
      refusals: args.refusals,
      platformLine: first.platformLine,
      trackUrl,
      sayToPerson: say,
      nextStep: nextStep("resubmit", say, trackUrl),
    },
    hint: `${say} The approval was spent on this upload; the new build needs a fresh one. ${args.statusRead} reads the record.`,
    warnings: args.warnings,
  });
}
