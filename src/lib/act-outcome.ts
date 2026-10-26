// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { setTimeout as timerSleep } from "node:timers/promises";

import { spokenDate } from "./publish-link";
import { trackFields } from "./track-url";

type Row = Record<string, unknown>;

export const WAIT_SECONDS_DEFAULT = 180;
export const WAIT_SECONDS_MAX = 600;
export const OUTCOME_POLL_MS = 5_000;

export const WAIT_SECONDS_INPUT = {
  type: "number",
  description:
    "How long, in seconds, this call waits for the platform's own record to show the act's result before answering: 0 to 600, default 180. 0 reads the record once and answers at once. When the bound passes first, the status is <act>-dispatched with value.outcome.recorded false, and the hint names the read that confirms it later. A read the platform does not answer (a timeout, a refused connection, a 429 or a 5xx) is retried after retryAfterSeconds while the bound lasts, and only when the bound is spent on such reads does value.outcome.readProblem name them with their count. With approvalId, a call that names waitSeconds also waits for an approval nobody has decided yet: it polls the approval every retryAfterSeconds up to the bound, and once a person approves it goes straight on to the act and the record wait in the same call, with what is left of the bound.",
};

export const outcomeClock = {
  now: (): number => Date.now(),
  sleep: async (ms: number): Promise<void> => {
    await timerSleep(ms);
  },
};

export function waitBound(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return WAIT_SECONDS_DEFAULT;

  return Math.min(WAIT_SECONDS_MAX, Math.max(0, Math.floor(n)));
}

export interface ActOutcome {
  recorded: boolean;
  status: string | null;
  storeState: string | null;
  liveState?: string | null;
  checkedAt: string;
  source: "platform-record";
  waitedSeconds: number;
  readProblem?: string;
  readMisses?: number;
}

export interface RecordMiss {
  ok: false;
  message: string;
  transient?: boolean;
  retryAfterSeconds?: number;
}

export type RecordRead<T> = { ok: true; record: T | null } | RecordMiss;

export const TRANSIENT_READ_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

export function missedRead(read: { status: number; message: string; retryAfterSeconds?: number }): RecordMiss {
  return {
    ok: false,
    message: read.message,
    transient: TRANSIENT_READ_STATUSES.has(read.status),
    ...(read.retryAfterSeconds ? { retryAfterSeconds: read.retryAfterSeconds } : {}),
  };
}

export function missesSentence(misses: number, waitedSeconds: number, last: string, what = "the record"): string {
  return `${last}; ${misses} ${misses === 1 ? "read" : "reads"} of ${what} missed over ${waitedSeconds} s`;
}

export function retryMs(retryAfterSeconds: unknown): number {
  const seconds = Number(retryAfterSeconds);

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : OUTCOME_POLL_MS;
}

export type Verdict =
  | { kind: "recorded"; status: string; storeState?: string | null; liveState?: string | null; failed?: boolean }
  | { kind: "unrecorded"; status?: string | null }
  | { kind: "waiting"; status?: string | null };

export interface AwaitedOutcome<T> {
  outcome: ActOutcome;
  record: T | null;
  failed: boolean;
}

export async function awaitRecordedOutcome<T>(args: {
  waitSeconds: unknown;
  read: () => Promise<RecordRead<T>>;
  judge: (record: T) => Verdict;
}): Promise<AwaitedOutcome<T>> {
  const boundMs = waitBound(args.waitSeconds) * 1000;
  const started = outcomeClock.now();
  let record: T | null = null;
  let seen: string | null = null;
  let readProblem: string | undefined;
  let misses = 0;

  for (;;) {
    const read = await args.read();

    if (!read.ok) {
      if (!read.transient) {
        readProblem = read.message;
        break;
      }

      misses += 1;
      const elapsed = outcomeClock.now() - started;

      if (elapsed >= boundMs) {
        readProblem = missesSentence(misses, Math.round(elapsed / 1000), read.message);
        break;
      }

      await outcomeClock.sleep(Math.min(retryMs(read.retryAfterSeconds), boundMs - elapsed));
      continue;
    }

    record = read.record;
    const verdict: Verdict = record === null ? { kind: "waiting" } : args.judge(record);
    if (verdict.status) seen = verdict.status;

    if (verdict.kind === "recorded") {
      return {
        outcome: {
          recorded: true,
          status: verdict.status,
          storeState: verdict.storeState ?? null,
          ...(verdict.liveState ? { liveState: verdict.liveState } : {}),
          checkedAt: new Date(outcomeClock.now()).toISOString(),
          source: "platform-record",
          waitedSeconds: Math.round((outcomeClock.now() - started) / 1000),
          ...(misses ? { readMisses: misses } : {}),
        },
        record,
        failed: verdict.failed === true,
      };
    }

    if (verdict.kind === "unrecorded") break;

    const elapsed = outcomeClock.now() - started;
    if (elapsed >= boundMs) break;

    await outcomeClock.sleep(Math.min(OUTCOME_POLL_MS, boundMs - elapsed));
  }

  return {
    outcome: {
      recorded: false,
      status: seen,
      storeState: null,
      checkedAt: new Date(outcomeClock.now()).toISOString(),
      source: "platform-record",
      waitedSeconds: Math.round((outcomeClock.now() - started) / 1000),
      ...(readProblem ? { readProblem } : {}),
      ...(misses ? { readMisses: misses } : {}),
    },
    record,
    failed: false,
  };
}

export function unrecordedOutcome(readProblem: string): ActOutcome {
  return {
    recorded: false,
    status: null,
    storeState: null,
    checkedAt: new Date(outcomeClock.now()).toISOString(),
    source: "platform-record",
    waitedSeconds: 0,
    readProblem,
  };
}

export function recordedOutcome(status: string, storeState: string | null = null): ActOutcome {
  return {
    recorded: true,
    status,
    storeState,
    checkedAt: new Date(outcomeClock.now()).toISOString(),
    source: "platform-record",
    waitedSeconds: 0,
  };
}

export type LinkKind = "track" | "share" | "channel" | "submission" | "item" | "approval" | "privacy" | "build" | "release" | "project";
export type LinkAudience = "anyone with the link" | "workspace members" | "the store's reviewers" | "you";

export interface ActLink {
  kind: LinkKind;
  url: string;
  audience: LinkAudience;
  expiresAt: string | null;
  made: boolean;
}

export type LinkRow = Partial<ActLink> & { kind: LinkKind; url?: string | null } & Record<string, unknown>;

const DEFAULT_AUDIENCE: Record<LinkKind, LinkAudience> = {
  track: "workspace members",
  share: "anyone with the link",
  channel: "anyone with the link",
  submission: "workspace members",
  item: "you",
  approval: "workspace members",
  privacy: "anyone with the link",
  build: "workspace members",
  release: "workspace members",
  project: "workspace members",
};

const KIND_NAMES: Record<LinkKind, string> = {
  track: "the console page",
  share: "the tester link",
  channel: "the channel link",
  submission: "the submission page",
  item: "the store's item page",
  approval: "the approval page",
  privacy: "the privacy page",
  build: "the build page",
  release: "the release page",
  project: "the project page",
};

export function linksOf(rows: LinkRow[]): ActLink[] {
  const out: ActLink[] = [];

  for (const row of rows) {
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!url) continue;

    const known = out.find((link) => link.url === url);

    if (known) {
      if (row.made === true) known.made = true;
      if (row.expiresAt && !known.expiresAt) known.expiresAt = row.expiresAt;

      if (known.kind === "track" && row.kind !== "track") {
        known.kind = row.kind;
        if (row.audience) known.audience = row.audience;
      }

      continue;
    }

    out.push({
      ...row,
      kind: row.kind,
      url,
      audience: row.audience ?? DEFAULT_AUDIENCE[row.kind],
      expiresAt: row.expiresAt ?? null,
      made: row.made === true,
    });
  }

  return out;
}

export function trackLinks(command: string, args: Row, status: string, value: Row): LinkRow[] {
  const fields = trackFields(command, { args, status, value });
  if (!fields) return [];

  const rows: LinkRow[] = fields.checkUrl
    ? [
        { kind: "approval", url: fields.trackUrl },
        { kind: "track", url: fields.checkUrl },
      ]
    : [{ kind: "track", url: fields.trackUrl }];
  const buildPage = fields.trackLinks?.[1];
  if (buildPage) rows.push({ kind: "build", url: buildPage });

  return rows;
}

function joined(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;

  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function shortDate(iso: string): string {
  return spokenDate(iso).replace(/,? \d{4} at .*$/, "");
}

const KIND_PLURALS: Record<LinkKind, string> = {
  track: "console pages",
  share: "tester links",
  channel: "channel links",
  submission: "submission pages",
  item: "store item pages",
  approval: "approval pages",
  privacy: "privacy pages",
  build: "build pages",
  release: "release pages",
  project: "project pages",
};

export function madeSentence(links: ActLink[]): string {
  const made = links.filter((link) => link.made);
  if (!made.length) return "Made: no new links.";

  const names: string[] = [];

  for (const kind of Object.keys(KIND_NAMES) as LinkKind[]) {
    const ofKind = made.filter((link) => link.kind === kind);
    if (!ofKind.length) continue;

    if (ofKind.length === 1) {
      const [link] = ofKind;
      names.push(`${KIND_NAMES[kind]}${link.expiresAt ? ` (expires ${shortDate(link.expiresAt)})` : ""}`);
      continue;
    }

    const expiry = ofKind.every((link) => link.expiresAt === ofKind[0].expiresAt) && ofKind[0].expiresAt ? ` (expire ${shortDate(ofKind[0].expiresAt)})` : "";
    names.push(`${ofKind.length} ${KIND_PLURALS[kind]}${expiry}`);
  }

  return `Made: ${joined(names)}.`;
}

export function dispatchedHint(args: { acceptedAt: string; trackUrl: string; readCall?: string; readHow?: string }): string {
  const read = args.readHow ?? `call ${args.readCall ?? "extension_release_status"} to read it`;

  return `The platform accepted the act at ${args.acceptedAt}; its record has not confirmed the result yet. Watch ${args.trackUrl}; ${read}.`;
}

export function dispatchedStatus(act: string): string {
  return `${act}-dispatched`;
}

export function stampNow(): string {
  return new Date(outcomeClock.now()).toISOString();
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

export function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const FAILED_STATUSES = new Set(["failed", "failure", "rejected", "error", "errored"]);
export const PENDING_STATUSES = new Set(["pending", "queued", "dispatched", "running", "in_progress", "in-progress", "building", "checking", "scheduled"]);

export function after(stamp: unknown, since: string): boolean {
  const at = Date.parse(text(stamp));
  const floor = Date.parse(since);
  if (!Number.isFinite(at) || !Number.isFinite(floor)) return false;

  return at >= floor;
}
