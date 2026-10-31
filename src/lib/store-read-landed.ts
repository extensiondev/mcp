// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { refreshCheckAt, type StoreRefreshView } from "./store-refresh-dispatch";

import type { SubmissionView } from "./store-row-sources";
import type { PollLaneView } from "../tools/store-status";

function stampOf(at: unknown): number {
  const ms = Date.parse(String(at ?? ""));

  return Number.isFinite(ms) ? ms : Number.NaN;
}

function laneRan(lane: PollLaneView | undefined): boolean {
  return lane?.ran === true && lane.checked !== 0;
}

export function rowReadAt(submission: SubmissionView | undefined): string | undefined {
  return submission?.statusRead?.readAt || submission?.storeReview?.checkedAt;
}

function readByPoll(submission: SubmissionView): boolean {
  if (submission.statusRead) return submission.statusRead.source === "poll";

  return submission.storeReview?.source === "poll";
}

export function stampPollRunRead(args: {
  submission: SubmissionView | undefined;
  lane: PollLaneView | undefined;
  lastPollAt: string | undefined;
  refresh: StoreRefreshView | undefined;
}): boolean {
  const { submission } = args;
  const dispatchedAt = stampOf(refreshCheckAt(args.refresh));
  const ranAt = stampOf(args.lastPollAt);

  if (!submission || !Number.isFinite(dispatchedAt) || !Number.isFinite(ranAt)) return false;
  if (ranAt < dispatchedAt || !laneRan(args.lane) || !readByPoll(submission)) return false;

  const readAt = stampOf(rowReadAt(submission));
  if (Number.isFinite(readAt) && readAt >= ranAt) return false;

  const at = args.lastPollAt as string;
  if (submission.statusRead) submission.statusRead.readAt = at;
  if (submission.storeReview) submission.storeReview.checkedAt = at;

  return true;
}

export function pollLanded(
  read: { rows: Array<Record<string, unknown>>; lastPollAt?: string },
  since: number,
  stores: string[],
): boolean {
  const polledSince = stampOf(read.lastPollAt) >= since;

  return stores.every((store) => {
    const row = read.rows.find((entry) => entry.store === store);
    const readAt = stampOf(rowReadAt(row?.lastSubmission as SubmissionView | undefined));

    if (Number.isFinite(readAt)) return readAt >= since;

    return polledSince && laneRan(row?.lastPollLane as PollLaneView | undefined);
  });
}

export function readsBeforeDispatch(
  stores: Array<{ store: string; readAt: string | null }>,
  refresh: Record<string, unknown> | null,
): string {
  const rows = stores.flatMap((entry) => {
    const own = refresh?.[entry.store];
    const dispatchedAt = own && typeof own === "object" ? String((own as { dispatchedAt?: unknown }).dispatchedAt ?? "") : "";
    if (!dispatchedAt) return [];
    if (!entry.readAt) return [`${entry.store} has no read time on its row`];
    if (stampOf(entry.readAt) >= stampOf(dispatchedAt)) return [];

    return [`${entry.store} was read at ${entry.readAt}, before the dispatch at ${dispatchedAt}`];
  });

  return rows.length ? ` (${rows.join("; ")})` : "";
}
