// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { openProjectApi, projectApiSend, type ProjectApiRefusal } from "./project-api";

export const REFRESHABLE_STORES = ["chrome", "edge", "firefox", "safari"] as const;

const STORE_POLL_RECENT = "STORE_POLL_RECENT";
const ISO_STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;

export interface StoreReadView {
  state: "live" | "absent" | "unreadable" | "unresolved";
  version?: string;
  manifestVersion?: string;
  listingUrl?: string;
  checkedAt?: string;
  reason?: string;
}

export interface StoreRefreshOwnView {
  dispatched: boolean;
  queued: boolean;
  dispatchedAt?: string;
  dueAt?: string;
  message?: string;
  storeRead?: StoreReadView;
  sharedWith?: string[];
}

export interface StoreRefreshCoveredView {
  covered: true;
  by: string;
  dispatchedAt: string;
  message?: string;
  storeRead?: StoreReadView;
}

export type StoreRefreshView = StoreRefreshOwnView | StoreRefreshCoveredView;

interface LeadCheck {
  store: string;
  dispatchedAt: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  const text = String(value ?? "").trim();

  return text || undefined;
}

function stampOf(at: unknown): number {
  const ms = Date.parse(String(at ?? ""));

  return Number.isFinite(ms) ? ms : Number.NaN;
}

export function refreshCovered(row: StoreRefreshView | undefined): row is StoreRefreshCoveredView {
  return Boolean(row) && (row as StoreRefreshCoveredView).covered === true;
}

export function refreshCheckAt(row: StoreRefreshView | undefined): string | undefined {
  if (!row) return undefined;
  if (refreshCovered(row)) return row.dispatchedAt;

  return row.dispatched ? row.dispatchedAt : undefined;
}

export function refreshInCheck(row: StoreRefreshView | undefined): boolean {
  return Boolean(row) && (refreshCovered(row) || (row as StoreRefreshOwnView).dispatched === true);
}

function storeReadOf(raw: unknown): StoreReadView | undefined {
  if (!isPlainObject(raw)) return undefined;

  const state = str(raw.state);

  if (state !== "live" && state !== "absent" && state !== "unreadable" && state !== "unresolved") return undefined;

  const view: StoreReadView = { state };

  for (const key of ["version", "manifestVersion", "listingUrl", "checkedAt", "reason"] as const) {
    const value = str(raw[key]);
    if (value) view[key] = value;
  }

  return view;
}

function checkStartedAt(body: unknown, message: string | undefined): number {
  const named = isPlainObject(body) ? str(body.lastPollAt) : undefined;
  if (named) return stampOf(named);

  const spoken = ISO_STAMP.exec(message ?? "")?.[0];

  return spoken ? stampOf(spoken) : Number.NaN;
}

function coveredByLead(lead: LeadCheck | null, startedAt: number): LeadCheck | null {
  if (!lead || !Number.isFinite(startedAt)) return null;

  return startedAt === stampOf(lead.dispatchedAt) ? lead : null;
}

function coveredRow(lead: LeadCheck, message: string | undefined, storeRead: StoreReadView | undefined): StoreRefreshCoveredView {
  return {
    covered: true,
    by: lead.store,
    dispatchedAt: lead.dispatchedAt,
    ...(message ? { message } : {}),
    ...(storeRead ? { storeRead } : {}),
  };
}

function refusedRow(sent: ProjectApiRefusal, lead: LeadCheck | null): StoreRefreshView {
  const sameCheck = sent.status === 429 && sent.code === STORE_POLL_RECENT ? coveredByLead(lead, checkStartedAt(sent.body, sent.message)) : null;
  if (sameCheck) return coveredRow(sameCheck, undefined, undefined);

  return { dispatched: false, queued: false, message: sent.message };
}

function answeredRow(json: Record<string, unknown>, lead: LeadCheck | null): StoreRefreshView {
  const dispatchedAt = str(json.dispatchedAt);
  const dueAt = str(json.dueAt);
  const message = str(json.message);
  const storeRead = storeReadOf(json.storeRead);
  const sameCheck = json.dispatched !== true && json.queued !== true ? coveredByLead(lead, checkStartedAt(json, message)) : null;
  if (sameCheck) return coveredRow(sameCheck, message, storeRead);

  return {
    dispatched: json.dispatched === true,
    queued: json.queued === true,
    ...(dispatchedAt ? { dispatchedAt } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(message ? { message } : {}),
    ...(storeRead ? { storeRead } : {}),
  };
}

export async function refreshStores(args: {
  stores: string[];
  project?: string;
  api?: string;
}): Promise<Record<string, StoreRefreshView>> {
  const wanted = args.stores
    .map((store) => String(store || "").trim().toLowerCase())
    .filter((store, index, all) => (REFRESHABLE_STORES as readonly string[]).includes(store) && all.indexOf(store) === index);
  const out: Record<string, StoreRefreshView> = {};

  if (!wanted.length) return out;

  const opened = await openProjectApi({ command: "extension_release_status", project: args.project, api: args.api });

  if (!opened.ok) {
    for (const store of wanted) out[store] = { dispatched: false, queued: false, message: opened.message };

    return out;
  }

  let lead: LeadCheck | null = null;

  for (const store of wanted) {
    const sent = await projectApiSend<Record<string, unknown>>(opened.api, "POST", `stores/${store}/poll`, {});
    const row: StoreRefreshView = sent.ok ? answeredRow(sent.json ?? {}, lead) : refusedRow(sent, lead);
    out[store] = row;

    if (!lead && !refreshCovered(row) && row.dispatched && row.dispatchedAt) lead = { store, dispatchedAt: row.dispatchedAt };
  }

  const covered = wanted.filter((store) => refreshCovered(out[store]));
  const leadRow = lead ? out[lead.store] : undefined;
  if (lead && leadRow && !refreshCovered(leadRow) && covered.length) leadRow.sharedWith = covered;

  return out;
}

export function spokenStores(stores: string[]): string {
  if (stores.length <= 1) return stores.join("");

  return `${stores.slice(0, -1).join(", ")} and ${stores[stores.length - 1]}`;
}
