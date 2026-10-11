// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { credentialsPath } from "./credentials";
import { withFileLock, writePrivateJson } from "./private-file";

export interface HeldBatch<Row> {
  workspace: string;
  refs: string[];
  grant: string;
  grantExpiresAt: number;
  rows: Row[];
}

type HeldFile = Record<string, HeldBatch<unknown>>;

export function heldBatchesPath(): string {
  return path.join(path.dirname(credentialsPath()), "provisioning.json");
}

function slot(apiBase: string, deviceCode: string): string {
  return crypto.createHash("sha256").update(`${apiBase}\n${deviceCode}`).digest("hex");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function readHeld(): HeldFile {
  try {
    const data = JSON.parse(fs.readFileSync(heldBatchesPath(), "utf8"));

    return data && typeof data === "object" && !Array.isArray(data) ? (data as HeldFile) : {};
  } catch {
    return {};
  }
}

function isHeldBatch(value: unknown): value is HeldBatch<unknown> {
  const batch = value as Partial<HeldBatch<unknown>> | null;

  return (
    Boolean(batch) &&
    typeof batch?.grant === "string" &&
    batch.grant.length > 0 &&
    typeof batch.grantExpiresAt === "number" &&
    typeof batch.workspace === "string" &&
    Array.isArray(batch.refs) &&
    Array.isArray(batch.rows)
  );
}

function rewrite(change: (held: HeldFile) => void): void {
  const file = heldBatchesPath();

  withFileLock(file, "provisioning store", () => {
    const held = readHeld();
    change(held);
    const now = nowSeconds();

    for (const [key, batch] of Object.entries(held)) {
      if (!isHeldBatch(batch) || batch.grantExpiresAt <= now) delete held[key];
    }

    if (Object.keys(held).length === 0) {
      fs.rmSync(file, { force: true });

      return;
    }

    writePrivateJson(file, held);
  });
}

export function saveHeldBatch<Row>(apiBase: string, deviceCode: string, batch: HeldBatch<Row>): boolean {
  try {
    rewrite((held) => {
      held[slot(apiBase, deviceCode)] = batch;
    });

    return true;
  } catch {
    return false;
  }
}

export function dropHeldBatch(apiBase: string, deviceCode: string): void {
  if (!fs.existsSync(heldBatchesPath())) return;

  try {
    rewrite((held) => {
      delete held[slot(apiBase, deviceCode)];
    });
  } catch {
  }
}

export function loadHeldBatch<Row>(apiBase: string, deviceCode: string): HeldBatch<Row> | null {
  const batch = readHeld()[slot(apiBase, deviceCode)];
  if (!batch) return null;

  if (!isHeldBatch(batch) || batch.grantExpiresAt <= nowSeconds()) {
    dropHeldBatch(apiBase, deviceCode);

    return null;
  }

  return batch as HeldBatch<Row>;
}
