// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { listCredentials, liveAt } from "./credentials";
import { targetServer } from "./credential-server";
import { envelope } from "./envelope";
import { mcpOrigins } from "./origins";
import { withoutRedirects } from "./platform-fetch";
import { isRow, text } from "./row";
import { nextStep, storeLabel } from "./store-connection";

type Args = Record<string, unknown>;

export const CONNECTED_STATUS = "workspace-store-connected";

export function workspaceToken(workspace: string, api?: string): string {
  const server = targetServer(api);
  const live = listCredentials().filter((entry) => entry.server === server && entry.workspaceSlug.toLowerCase() === workspace && liveAt(entry));
  const member = live.find((entry) => entry.kind === "member");

  return (member ?? live.sort((a, b) => b.expiresAt - a.expiresAt)[0])?.token ?? "";
}

export interface StoreAccountView {
  connectedAs: string | null;
  connectedAt: string | null;
  checkedAt: string | null;
  healthy: boolean | null;
  reason?: string;
  state?: string;
}

export type StoreAccountRead = { account: StoreAccountView | null } | { unread: string };

function nullableText(value: unknown): string | null {
  return text(value) || null;
}

/* @invariant A GUIDED CONNECT READS THE WORKSPACE'S STORE ACCOUNTS BEFORE IT
 * OPENS ANYTHING (MCP ledger 1120). A store the workspace already holds is
 * answered with who connected it, since when and its last check, and no
 * window opens, since the console offers no guide panel for a connected
 * store. Only replace: true opens the guided flow over a connected store. A
 * read that fails keeps the guided flow and says the state was not read.
 */
export async function readStoreAccount(options: { workspace: string; store: string; api?: string; fetchImpl: typeof fetch }): Promise<StoreAccountRead> {
  const token = workspaceToken(options.workspace, options.api);
  if (!token) return { unread: `no login for ${options.workspace} is on this machine` };

  try {
    const res = await withoutRedirects(options.fetchImpl)(`${mcpOrigins(options.api).www}/api/workspaces/${encodeURIComponent(options.workspace)}/store-accounts`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) return { unread: `the platform answered ${res.status}` };

    const body: unknown = await res.json().catch(() => null);
    const accounts = isRow(body) && isRow(body.storeAccounts) ? body.storeAccounts : null;
    if (!accounts) return { unread: "the platform answered without store accounts" };

    const row = accounts[options.store];
    if (!isRow(row)) return { account: null };

    return {
      account: {
        connectedAs: nullableText(row.connectedAs),
        connectedAt: nullableText(row.connectedAt),
        checkedAt: nullableText(row.checkedAt),
        healthy: typeof row.healthy === "boolean" ? row.healthy : null,
        ...(text(row.reason) ? { reason: text(row.reason) } : {}),
        ...(text(row.state) ? { state: text(row.state) } : {}),
      },
    };
  } catch (err) {
    return { unread: err instanceof Error ? err.message : String(err) };
  }
}

function shownTime(raw: string): string {
  const at = Date.parse(raw);

  return Number.isFinite(at) ? new Date(at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : raw;
}

export function replacing(args: Args): boolean {
  return args.replace === true || text(args.replace).toLowerCase() === "true";
}

export function replaceCall(workspace: string, store: string): string {
  return `extension_submit {action:"connect", workspace:"${workspace}", browsers:["${store}"], replace:true}`;
}

export function connectedAnswer(command: string, connect: { workspace: string; project: string; store: string; url: string }, account: StoreAccountView): string {
  const { workspace, project, store, url } = connect;
  const name = storeLabel(store);
  const who = account.connectedAs ? ` as ${account.connectedAs}` : "";
  const since = account.connectedAt ? ` since ${shownTime(account.connectedAt)}` : "";
  const why = account.reason ? `: ${account.reason}` : "";
  const check = !account.checkedAt
    ? "it has not been checked yet"
    : account.healthy === false
      ? `its last check on ${shownTime(account.checkedAt)} failed${why}`
      : `its last check on ${shownTime(account.checkedAt)} ${account.healthy ? "passed" : "has no answer yet"}`;
  const say = `${name} is already connected for ${workspace}${who}${since}, and ${check}. To use a new key instead, ask to replace it and the guided window opens for the new key.`;

  return envelope({
    ok: true,
    command,
    status: CONNECTED_STATUS,
    value: {
      workspace,
      ...(project ? { project } : {}),
      store,
      storeAccountsUrl: url,
      account,
      guidedBrowser: { opened: false },
      sayToPerson: say,
      nextStep: nextStep(account.healthy === false ? "connect" : "done", say, url),
    },
    hint: [
      `No window was opened: ${workspace} already holds a ${name} account.`,
      project ? `${project} uses it unless it holds a key of its own.` : "",
      `Tell the person: "${say}" Only when they ask for a new key, call ${replaceCall(workspace, store)}.`,
    ].filter(Boolean).join(" "),
  });
}
