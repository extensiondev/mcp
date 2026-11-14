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
export const STATE_TIMEOUT_MS = 15_000;

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
        signal: AbortSignal.timeout(STATE_TIMEOUT_MS),
      },
      session.fetchImpl,
    );

    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

const LANE_SWITCHES: Readonly<Record<string, string>> = Object.freeze({
  FORWARD_LANE_CLOSED: "WWW_FORWARD_LANE is off on extension.dev",
  HOSTED_STATE_OFF: "the store behind this door is off on extension.dev",
});

/* @invariant A CLOSED DOOR IS CALLED CLOSED, NEVER AN EMPTY RECORD. A 503
 * from a hosted state door says nothing about the record that was asked
 * for: a held grant that could not be read may well exist, and one that
 * could not be saved was not saved. Reading that answer as no record made a
 * closed lane look like a grant that never existed, so it is thrown by name
 * instead, with the door and the switch behind it, and the login is not
 * blamed.
 */
export class ForwardLaneClosedError extends Error {
  readonly door: string;
  readonly code: string;

  constructor(door: string, code: string) {
    super(
      `The hosted lane's ${door} door is closed: ${LANE_SWITCHES[code] ?? "the platform answered 503 without naming a switch"}. This login is fine; the record was neither read nor written, so nothing here says it does not exist. Try again once the lane is open; the local tools keep working meanwhile.`,
    );

    this.name = "ForwardLaneClosedError";
    this.door = door;
    this.code = code;
  }
}

function openDoor(path: string, answer: { status: number; body: unknown }): { status: number; body: unknown } {
  if (answer.status !== 503) return answer;

  throw new ForwardLaneClosedError(path.slice(path.lastIndexOf("/") + 1), String(field(answer.body, "code") ?? "").slice(0, 64));
}

async function read(session: ForwardSession, path: string, body: Row): Promise<unknown> {
  const answer = openDoor(path, await call(session, "POST", path, body));

  return answer.status === 200 ? answer.body : null;
}

async function write(session: ForwardSession, method: "PUT" | "DELETE", path: string, body: Row): Promise<boolean> {
  return openDoor(path, await call(session, method, path, body)).status === 200;
}

export type ApprovalHolder =
  | { kind: "holder"; workspace: string; project: string; loginId: string }
  | { kind: "record"; record: MintedApproval }
  | { kind: "unknown" }
  | { kind: "unanswered" };

/* @invariant ONE READ SAYS WHICH OF THE PERSON'S PROJECTS HOLDS AN APPROVAL.
 * www names the project and the login an approval was filed under to any
 * forward credential of the same person, and nothing about anyone else's.
 * The answer is told apart from an older www by its shape: a project and a
 * login id is the holder; a record is an older www answering for the asking
 * login's own project; a 404 that repeats the flag is this person holding
 * no such approval anywhere, so no other login is asked; any other answer
 * says nothing, and the caller falls back to asking its logins in turn.
 */
export async function forwardApprovalHolder(session: ForwardSession, approvalId: string): Promise<ApprovalHolder> {
  const answer = openDoor(APPROVALS_PATH, await call(session, "POST", APPROVALS_PATH, { approvalId, anyProject: true }));
  const [workspace = "", project = ""] = String(field(answer.body, "project") ?? "").toLowerCase().split("/");
  const loginId = field(answer.body, "loginId");

  if (answer.status === 200 && workspace && project && typeof loginId === "string" && loginId) return { kind: "holder", workspace, project, loginId };

  const record = answer.status === 200 ? approvalOf(field(answer.body, "record")) : null;
  if (record) return { kind: "record", record };

  return answer.status === 404 && field(answer.body, "anyProject") === true ? { kind: "unknown" } : { kind: "unanswered" };
}

/* @invariant ON THE FORWARDER PATH THE APPROVALS, HELD GRANTS AND PENDING
 * CREATES ARE THE HOSTED LANE'S, NOT THIS MACHINE'S FILES. A forwarded act
 * mints and spends its approval in www's hosted state, so a local step the
 * forwarder runs itself (a device poll that holds a create grant, a capture
 * sync that asks for approval) reads and writes the same records through
 * www's forward state doors with a forward credential, and a later hosted
 * call finds them. An answer www does not give is read as no record, and a
 * door that answers 503 is thrown as closed, never read as one. Outside
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
      const answer = openDoor(APPROVALS_PATH, await call(session, "PUT", APPROVALS_PATH, { approvalId: args.approvalId }));

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
