// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { serverOf } from "./credential-server";
import { credentialsPath } from "./credentials";
import { withFileLock, writePrivateJson } from "./private-file";

export interface PendingCreate {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: string;
}

type PendingFile = Record<string, Record<string, PendingCreate>>;

export function pendingCreatesPath(): string {
  return path.join(path.dirname(credentialsPath()), "pending-creates.json");
}

function readPending(): PendingFile {
  try {
    const data = JSON.parse(fs.readFileSync(pendingCreatesPath(), "utf8"));

    return data && typeof data === "object" && !Array.isArray(data) ? (data as PendingFile) : {};
  } catch {
    return {};
  }
}

function isPending(value: unknown): value is PendingCreate {
  const record = value as Partial<PendingCreate> | null;

  return Boolean(record) && typeof record?.userCode === "string" && typeof record.verificationUri === "string" && typeof record.expiresAt === "string";
}

function live(record: PendingCreate, now: number): boolean {
  const expires = Date.parse(record.expiresAt);

  return Number.isFinite(expires) && expires > now;
}

function rewrite(change: (pending: PendingFile) => void): void {
  const file = pendingCreatesPath();

  withFileLock(file, "pending creates record", () => {
    const pending = readPending();
    change(pending);
    const now = Date.now();

    for (const [server, byRef] of Object.entries(pending)) {
      if (!byRef || typeof byRef !== "object") {
        delete pending[server];
        continue;
      }

      for (const [ref, record] of Object.entries(byRef)) {
        if (!isPending(record) || !live(record, now)) delete byRef[ref];
      }

      if (Object.keys(byRef).length === 0) delete pending[server];
    }

    if (Object.keys(pending).length === 0) {
      fs.rmSync(file, { force: true });

      return;
    }

    writePrivateJson(file, pending);
  });
}

export function rememberPendingCreate(apiBase: string, project: string, record: PendingCreate): boolean {
  const server = serverOf(apiBase);
  const ref = project.toLowerCase();

  try {
    rewrite((pending) => {
      pending[server] = { ...(pending[server] ?? {}), [ref]: record };
    });

    return true;
  } catch {
    return false;
  }
}

export function forgetPendingCreate(apiBase: string, project: string): void {
  if (!fs.existsSync(pendingCreatesPath())) return;

  try {
    rewrite((pending) => {
      delete pending[serverOf(apiBase)]?.[project.toLowerCase()];
    });
  } catch {
  }
}

export function pendingCreate(apiBase: string, project: string): PendingCreate | null {
  const record = readPending()[serverOf(apiBase)]?.[project.toLowerCase()];

  return record && isPending(record) && live(record, Date.now()) ? record : null;
}
