// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { consoleProjectUrl } from "./console-urls";
import { AMO_API_KEY_PAGE } from "./firefox-store";
import { isRow, text } from "./ship-act";

import type { ProjectRef } from "./registry";

export const CONNECT_ACTION = "connect";

export const CONNECT_STORES = ["chrome", "firefox", "edge", "safari"] as const;

export type ConnectStore = (typeof CONNECT_STORES)[number];

export const CONNECT_WAIT_MAX_SECONDS = 600;

export const STORE_KEY_PAGES: Record<ConnectStore, string | null> = {
  chrome: null,
  firefox: AMO_API_KEY_PAGE,
  edge: "https://partner.microsoft.com/dashboard/microsoftedge/publishapi",
  safari: "https://appstoreconnect.apple.com/access/integrations/api",
};

export const CONNECT_STORE_NAMES: Record<ConnectStore, string> = {
  chrome: "the Chrome Web Store",
  firefox: "Firefox Add-ons",
  edge: "Edge Add-ons",
  safari: "the App Store",
};

const HANDOFF: Record<ConnectStore, string> = {
  chrome: "press Continue with Google and allow extension.dev to publish for you; Google keeps the key",
  firefox: "copy the JWT issuer and the JWT secret from the AMO key page and press Paste beside each field, or drop the file you saved them in",
  edge: "copy the Client ID and the API key from Partner Center's Publish API page and press Paste beside each field, and give the Product ID from the extension's Partner Center page",
  safari: "give the issuer ID and the key ID from App Store Connect, then drop the .p8 key file you downloaded onto the page",
};

export function isConnectStore(value: string): value is ConnectStore {
  return (CONNECT_STORES as readonly string[]).includes(value);
}

export type ConnectSessionStatus = "pending" | "connected" | "expired";

export interface ConnectSession {
  id: string;
  store: ConnectStore;
  status: ConnectSessionStatus;
  userCode: string;
  actor: string;
  expiresAt: string;
  intervalSeconds: number;
  connectedAs: string | null;
  product: string | null;
  connectedAt: string | null;
  refusal: { message: string; at: string } | null;
}

const STATUSES = new Set<string>(["pending", "connected", "expired"]);

export function accountOf(store: ConnectStore, named: string, savedProduct = ""): { connectedAs: string | null; product: string | null } {
  if (store === "edge") return { connectedAs: null, product: named || savedProduct || null };

  return { connectedAs: named || null, product: null };
}

export function accountPhrase(account: { connectedAs: string | null; product: string | null }): string {
  if (account.product) return ` for product ${account.product} (Edge names no account; the key was checked against that product)`;

  return account.connectedAs ? ` as ${account.connectedAs}` : "";
}

export function readConnectSession(body: unknown, store: ConnectStore): ConnectSession | null {
  const row = isRow(body) && isRow(body.session) ? body.session : null;
  if (!row || !text(row.id)) return null;

  const status = STATUSES.has(text(row.status)) ? (text(row.status) as ConnectSessionStatus) : "pending";
  const interval = Number(row.intervalSeconds);
  const refusal = isRow(row.lastRefusal) && text(row.lastRefusal.message) ? { message: text(row.lastRefusal.message), at: text(row.lastRefusal.at) } : null;

  return {
    id: text(row.id),
    store,
    status,
    userCode: text(row.userCode),
    actor: text(row.actor),
    expiresAt: text(row.expiresAt),
    intervalSeconds: Number.isFinite(interval) && interval >= 0 ? Math.min(interval, 10) : 5,
    ...accountOf(store, status === "connected" ? text(row.connectedAs) : ""),
    connectedAt: status === "connected" ? text(row.connectedAt) || null : null,
    refusal,
  };
}

export function connectPagePath(store: ConnectStore): string {
  return `connect/${store}`;
}

export function connectPageUrls(ref: ProjectRef | null, session: Pick<ConnectSession, "id" | "store" | "userCode">, api?: string): { connectUrl: string; codeUrl: string } {
  const page = consoleProjectUrl(ref, connectPagePath(session.store), api);

  return {
    connectUrl: `${page}?session=${encodeURIComponent(session.id)}`,
    codeUrl: page,
  };
}

export function connectSessionRoute(store: ConnectStore): string {
  return `stores/${store}/connect-session`;
}

export function handoffSentence(store: ConnectStore, savedProduct = ""): string {
  if (store === "edge" && savedProduct) {
    return `copy the Client ID and the API key from Partner Center's Publish API page and press Paste beside each field; the Product ID is already filled with the saved product ${savedProduct}`;
  }

  return HANDOFF[store];
}

export function pendingSentences(args: {
  store: ConnectStore;
  project: string;
  session: ConnectSession;
  connectUrl: string;
  codeUrl: string;
  opened: boolean;
  savedProduct?: string;
}): string {
  const name = CONNECT_STORE_NAMES[args.store];
  const keyPage = STORE_KEY_PAGES[args.store];
  const where = args.opened
    ? `The page "Connect ${name} for ${args.project}" is open in your browser${keyPage ? `, next to the store's key page ${keyPage}` : ""}.`
    : `Open ${args.connectUrl} to connect ${name} for ${args.project}${keyPage ? `; the store's key page is ${keyPage}` : ""}.`;
  const other = `On another device, open ${args.codeUrl} and enter the code ${args.session.userCode}${args.session.actor ? `, signed in as ${args.session.actor}` : ""}.`;
  const refused = args.session.refusal ? ` The store refused the last key with: ${args.session.refusal.message}` : "";

  return `${where} There, ${handoffSentence(args.store, args.savedProduct)}. ${other} The key goes from your clipboard or file straight to extension.dev, never through this chat, and is saved only after the store accepts it.${refused}`;
}

export function connectedSentence(store: ConnectStore, session: ConnectSession): string {
  const account = accountPhrase(session);
  const at = session.connectedAt ? `, checked by the store at ${session.connectedAt}` : "";

  return `${CONNECT_STORE_NAMES[store]} is connected${account}${at}. Say preflight and I read the store's readiness now.`;
}
