// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { WAIT_SECONDS_MAX } from "./act-outcome";
import { PLATFORM_DISPATCH_TIMEOUT_MS } from "./platform-fetch";
import { readSubmissionRecords, type PlatformSubmission } from "./platform-submissions";

import type { ProjectApi } from "./project-api";

export const SUBMIT_DISPATCH_PER_STORE_MS = 60_000;
export const SUBMIT_DISPATCH_CEILING_MS = WAIT_SECONDS_MAX * 1000;
export const SUBMIT_CLOCK_SLACK_MS = 15_000;

export function submitDispatchBoundMs(storeCount: number, waitSeconds: unknown): number {
  const stores = Math.max(1, Math.floor(Number(storeCount) || 0));
  const raw = typeof waitSeconds === "string" && waitSeconds.trim() !== "" ? Number(waitSeconds) : waitSeconds;
  const asked = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) * 1000 : Infinity;
  const scaled = Math.min(SUBMIT_DISPATCH_CEILING_MS, stores * SUBMIT_DISPATCH_PER_STORE_MS, asked);

  return Math.max(PLATFORM_DISPATCH_TIMEOUT_MS, scaled);
}

export interface StoreAfterUnconfirmed {
  submitted: boolean;
  submissionId?: string;
  version?: string;
  submittedAt?: string;
}

export interface StoresAfterUnconfirmed {
  stores: Record<string, StoreAfterUnconfirmed>;
  went: string[];
  stayed: string[];
  readAt: string;
  readProblem?: string;
}

function newerThan(record: PlatformSubmission | undefined, startedAt: number): StoreAfterUnconfirmed {
  const submittedAt = String(record?.submittedAt ?? "").trim();
  const at = Date.parse(submittedAt);

  if (!record || !Number.isFinite(at) || at < startedAt - SUBMIT_CLOCK_SLACK_MS) return { submitted: false };

  const submissionId = String(record.id ?? "").trim();
  const version = String(record.storeVersion?.packaged ?? record.version ?? "").trim();

  return {
    submitted: true,
    ...(submissionId ? { submissionId } : {}),
    ...(version ? { version } : {}),
    submittedAt,
  };
}

export async function readStoresAfterUnconfirmed(args: {
  api: Pick<ProjectApi, "base" | "token" | "command">;
  browsers: string[];
  startedAt: number;
}): Promise<StoresAfterUnconfirmed> {
  const readAt = new Date().toISOString();
  const read = await readSubmissionRecords(args.api);

  if (!read.ok) {
    return { stores: {}, went: [], stayed: [...args.browsers], readAt, readProblem: read.message };
  }

  const byStore = read.record ?? {};
  const stores = Object.fromEntries(args.browsers.map((store) => [store, newerThan(byStore[store], args.startedAt)]));
  const went = args.browsers.filter((store) => stores[store]?.submitted);
  const stayed = args.browsers.filter((store) => !stores[store]?.submitted);

  return { stores, went, stayed, readAt };
}

function idsOf(read: StoresAfterUnconfirmed): string {
  return read.went
    .map((store) => {
      const row = read.stores[store];
      const parts = [row?.submissionId, row?.version ? `version ${row.version}` : "", row?.submittedAt ? `at ${row.submittedAt}` : ""].filter(Boolean);

      return parts.length ? `${store} ${parts.join(", ")}` : store;
    })
    .join("; ");
}

export function unconfirmedStoresHint(read: StoresAfterUnconfirmed, statusRead: string): string {
  const lead = "Do not submit again blind: a store that was dispatched would be submitted twice.";

  if (read.readProblem) {
    return `${lead} The per-store records could not be read after the cut (${read.readProblem}). Read ${statusRead} first and submit only the stores with no new submission.`;
  }

  if (read.stayed.length === 0) {
    return `${lead} Every store asked went out after this call started (${idsOf(read)}), so nothing is left to submit; ${statusRead} follows the records.`;
  }

  const serial = "The platform submits the stores one after another inside the request, so a store with no record yet may still be uploading";

  if (read.went.length === 0) {
    return `${lead} None of ${read.stayed.join(", ")} has a submission newer than this call (records read at ${read.readAt}). ${serial}: read ${statusRead} again in a minute and submit again only the stores that still show none.`;
  }

  return `${lead} ${read.went.join(", ")} went out (${idsOf(read)}); ${read.stayed.join(", ")} ${read.stayed.length === 1 ? "has" : "have"} no submission newer than this call (records read at ${read.readAt}). ${serial}: read ${statusRead} again in a minute and submit again with browsers limited to ${read.stayed.join(", ")} only if it still shows none; never repeat ${read.went.join(", ")}.`;
}
