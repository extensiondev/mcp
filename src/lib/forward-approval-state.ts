// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { AsyncLocalStorage } from "node:async_hooks";

import { FILE_APPROVAL_STATE } from "./approval-state-local";
import { forwardCredential } from "./forward-credential";
import { bearerFetch } from "./platform-fetch";
import { PROJECT_HEADER } from "./request-fetch";

import type { ApprovalState, HeldBatch, MintedApproval, PendingCreate } from "./approval-state";

export const APPROVALS_PATH = "/api/cli/forward/approvals";
export const HELD_GRANTS_PATH = "/api/cli/forward/held-grants";
export const PENDING_CREATES_PATH = "/api/cli/forward/pending-creates";

export interface ForwardSession {
  api: string;
  login: string;
  project: string | null;
  resource: string;
  fetchImpl?: typeof fetch;
}

type Row = Record<string, unknown>;

const sessions = new AsyncLocalStorage<ForwardSession>();

export function withForwardSession<T>(session: ForwardSession, run: () => T): T {
  return sessions.run(session, run);
}

export function forwardSession(): ForwardSession | null {
  return sessions.getStore() ?? null;
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function field(body: unknown, name: string): unknown {
  return isRow(body) ? body[name] : undefined;
}

function approvalOf(value: unknown): MintedApproval | null {
  return isRow(value) && typeof value.approvalId === "string" && typeof value.fingerprint === "string" ? (value as unknown as MintedApproval) : null;
}

function heldOf<R>(value: unknown): HeldBatch<R> | null {
  if (!isRow(value) || typeof value.grant !== "string" || typeof value.grantExpiresAt !== "number" || !Array.isArray(value.refs)) return null;

  const creatingSince = typeof value.creatingSince === "number" ? value.creatingSince * 1000 : undefined;

  return {
    workspace: String(value.workspace ?? ""),
    refs: value.refs.map(String),
    grant: value.grant,
    grantExpiresAt: value.grantExpiresAt,
    rows: (Array.isArray(value.rows) ? value.rows : []) as R[],
    ...(creatingSince ? { creatingSince } : {}),
  };
}

function pendingOf(value: unknown): PendingCreate | null {
  if (!isRow(value) || typeof value.userCode !== "string" || typeof value.verificationUri !== "string" || typeof value.expiresAt !== "string") return null;

  return {
    userCode: value.userCode,
    verificationUri: value.verificationUri,
    ...(typeof value.verificationUriComplete === "string" ? { verificationUriComplete: value.verificationUriComplete } : {}),
    expiresAt: value.expiresAt,
  };
}

async function call(session: ForwardSession, method: "POST" | "PUT" | "DELETE", path: string, body: Row): Promise<{ status: number; body: unknown }> {
  const credential = await forwardCredential(session);
  if (!credential.ok) return { status: credential.status, body: null };

  try {
    const res = await bearerFetch(
      `${session.api.replace(/\/+$/, "")}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${credential.credential.token}`,
          accept: "application/json",
          "content-type": "application/json",
          ...(session.project ? { [PROJECT_HEADER]: session.project } : {}),
        },
        body: JSON.stringify(body),
      },
      session.fetchImpl,
    );

    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

async function read(session: ForwardSession, path: string, body: Row): Promise<unknown> {
  const answer = await call(session, "POST", path, body);

  return answer.status === 200 ? answer.body : null;
}

async function write(session: ForwardSession, method: "PUT" | "DELETE", path: string, body: Row): Promise<boolean> {
  return (await call(session, method, path, body)).status === 200;
}

/* @invariant ON THE FORWARDER PATH THE APPROVALS, HELD GRANTS AND PENDING
 * CREATES ARE THE HOSTED LANE'S, NOT THIS MACHINE'S FILES. A forwarded act
 * mints and spends its approval in www's hosted state, so a local step the
 * forwarder runs itself (a device poll that holds a create grant, a capture
 * sync that asks for approval) reads and writes the same records through
 * www's forward state doors with a forward credential, and a later hosted
 * call finds them. An answer www does not give is read as no record. Outside
 * a forwarded call, and on the default in-process path, the file store
 * answers exactly as before.
 */
export function wwwApprovalState(session: ForwardSession): ApprovalState {
  return {
    async mintedApproval(_api, approvalId) {
      return approvalOf(field(await read(session, APPROVALS_PATH, { approvalId }), "record"));
    },
    async standingApprovalForAct(args) {
      return approvalOf(field(await read(session, APPROVALS_PATH, { action: args.action, fingerprint: args.fingerprint }), "record"));
    },
    async rememberMintedApproval(args) {
      const answer = await call(session, "PUT", APPROVALS_PATH, { approvalId: args.approvalId });

      return answer.status === 200 ? approvalOf(field(answer.body, "record")) : null;
    },
    async loadHeldBatch<R>(_apiBase: string, deviceCode: string) {
      return heldOf<R>(field(await read(session, HELD_GRANTS_PATH, { deviceCode }), "held"));
    },
    async heldBatchForRef(_apiBase, ref) {
      return heldOf<unknown>(field(await read(session, HELD_GRANTS_PATH, { ref }), "held"));
    },
    async saveHeldBatch(_apiBase, deviceCode, batch) {
      return write(session, "PUT", HELD_GRANTS_PATH, {
        deviceCode,
        grant: batch.grant,
        workspace: batch.workspace,
        refs: batch.refs,
        rows: batch.rows,
        ...(batch.creatingSince ? { creatingSince: Math.floor(batch.creatingSince / 1000) } : {}),
      });
    },
    async dropHeldBatch(_apiBase, deviceCode) {
      await write(session, "DELETE", HELD_GRANTS_PATH, { deviceCode });
    },
    async pendingCreate(_apiBase, project) {
      return pendingOf(field(await read(session, PENDING_CREATES_PATH, { project }), "pending"));
    },
    async rememberPendingCreate(_apiBase, project, record) {
      return write(session, "PUT", PENDING_CREATES_PATH, { project, ...record });
    },
    async forgetPendingCreate(_apiBase, project) {
      await write(session, "DELETE", PENDING_CREATES_PATH, { project });
    },
  };
}

export function forwarderApprovalState(): ApprovalState {
  const session = forwardSession();

  return session ? wwwApprovalState(session) : FILE_APPROVAL_STATE;
}
