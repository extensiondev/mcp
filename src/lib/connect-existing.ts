// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { accountOf, type ConnectStore } from "./connect-session";
import { projectApiGet, projectApiSend, type ProjectApi, type ProjectApiRead } from "./project-api";
import { isRow, text } from "./ship-act";
import { WORKSPACE_RECONNECT_STATE } from "./store-connection";

type Row = Record<string, unknown>;

export const CHECK_INTERVAL_MS = 10_000;

export const CHECK_READS = 15;

export const POLL_RECENT_CODE = "STORE_POLL_RECENT";

export interface SavedConnection {
  source: "project" | "workspace";
  kind: string;
  connectedAs: string | null;
  product: string | null;
  connectedAt: string | null;
  checkedAt: string | null;
  healthy: boolean | null;
  reason: string;
  reconnect: boolean;
}

export interface ConnectionCheck {
  connection: SavedConnection;
  checkedNow: boolean;
  notNow: string;
}

export type SavedRead = { read: true; connection: SavedConnection | null; savedProduct: string } | { read: false; message: string };

let pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function setConnectCheckPause(next: (ms: number) => Promise<void>): () => void {
  const previous = pause;
  pause = next;

  return () => {
    pause = previous;
  };
}

export function savedProductOf(config: unknown, store: ConnectStore): string {
  const view = store === "edge" && isRow(config) && isRow(config.edge) ? (config.edge as Row) : null;

  return view ? text(view.storeId) : "";
}

export function savedConnectionOf(config: unknown, store: ConnectStore): SavedConnection | null {
  const view = isRow(config) && isRow(config[store]) ? (config[store] as Row) : null;
  const row = view && isRow(view.connection) ? (view.connection as Row) : null;
  if (!row || !text(row.kind)) return null;

  return {
    source: text(row.source) === "workspace" ? "workspace" : "project",
    kind: text(row.kind),
    ...accountOf(store, text(row.connectedAs), savedProductOf(config, store)),
    connectedAt: text(row.connectedAt) || null,
    checkedAt: text(row.checkedAt) || null,
    healthy: typeof row.healthy === "boolean" ? row.healthy : null,
    reason: text(row.reason) || text(row.message),
    reconnect: text(row.state) === WORKSPACE_RECONNECT_STATE,
  };
}

export async function readSavedConnection(api: ProjectApi, store: ConnectStore): Promise<SavedRead> {
  const read = await projectApiGet<Row>(api, "stores/config").catch(() => null);
  if (!read || !read.ok) return { read: false, message: read?.message || "the store settings could not be read" };

  return { read: true, connection: savedConnectionOf(read.json, store), savedProduct: savedProductOf(read.json, store) };
}

function refusalWords(read: ProjectApiRead<Row> | null, fallback: string): string {
  if (!read) return fallback;
  if (read.ok) return text(read.json.message) || fallback;

  return (isRow(read.body) && text(read.body.message)) || read.message || fallback;
}

async function checkChrome(api: ProjectApi, saved: SavedConnection): Promise<ConnectionCheck> {
  const read = await projectApiGet<Row>(api, "stores/chrome/health").catch(() => null);

  if (read?.ok && typeof read.json.healthy === "boolean") {
    return {
      connection: {
        ...saved,
        healthy: read.json.healthy,
        checkedAt: text(read.json.checkedAt) || saved.checkedAt,
        connectedAs: text(read.json.connectedAs) || saved.connectedAs,
        reason: read.json.healthy ? "" : text(read.json.reason) || saved.reason,
      },
      checkedNow: true,
      notNow: "",
    };
  }

  return { connection: saved, checkedNow: false, notNow: refusalWords(read, "the platform did not run Google's token check for this caller") };
}

async function checkOnMirror(api: ProjectApi, store: ConnectStore, saved: SavedConnection): Promise<ConnectionCheck> {
  const asked = await projectApiSend<Row>(api, "POST", `stores/${store}/poll`, {}).catch(() => null);
  const running = Boolean(asked && ((asked.ok && asked.json.dispatched === true) || (!asked.ok && asked.code === POLL_RECENT_CODE)));

  if (!running) return { connection: saved, checkedNow: false, notNow: refusalWords(asked, "the platform did not start the store check") };

  for (let i = 0; i < CHECK_READS; i += 1) {
    await pause(CHECK_INTERVAL_MS);

    const now = await readSavedConnection(api, store);
    if (!now.read || !now.connection) continue;
    if (now.connection.checkedAt && now.connection.checkedAt !== saved.checkedAt) return { connection: now.connection, checkedNow: true, notNow: "" };
  }

  return { connection: saved, checkedNow: false, notNow: `the store check did not answer within ${(CHECK_INTERVAL_MS * CHECK_READS) / 1000} seconds` };
}

export async function checkSavedConnection(api: ProjectApi, store: ConnectStore, saved: SavedConnection): Promise<ConnectionCheck> {
  if (saved.source === "workspace") return { connection: saved, checkedNow: false, notNow: "" };
  if (store === "chrome") return checkChrome(api, saved);

  return checkOnMirror(api, store, saved);
}
