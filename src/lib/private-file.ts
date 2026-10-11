// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

export function ensurePrivateDir(file: string): string {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  try {
    fs.chmodSync(dir, 0o700);
  } catch {
  }

  return file;
}

export function writePrivateJson(file: string, data: unknown): string {
  ensurePrivateDir(file);
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(tmpFile, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });

    try {
      fs.chmodSync(tmpFile, 0o600);
    } catch {
    }

    fs.renameSync(tmpFile, file);
  } catch (err) {
    fs.rmSync(tmpFile, { force: true });

    throw err;
  }

  return file;
}

const LOCK_STALE_MS = 2_000;
const LOCK_WAIT_MS = 3_000;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function takeLock(lock: string): boolean {
  try {
    fs.closeSync(fs.openSync(lock, "wx", 0o600));

    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;

    return false;
  }
}

function lockAgeMs(lock: string): number | null {
  try {
    return Date.now() - fs.statSync(lock).mtimeMs;
  } catch {
    return null;
  }
}

export function withFileLock<T>(file: string, what: string, change: () => T): T {
  ensurePrivateDir(file);
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (!takeLock(lock)) {
    const age = lockAgeMs(lock);
    if (age === null) continue;

    if (age > LOCK_STALE_MS) {
      fs.rmSync(lock, { force: true });
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Another process is writing the ${what} at ${file} and did not finish in ${LOCK_WAIT_MS} ms; nothing was stored. Try again.`,
      );
    }

    pause(25);
  }

  try {
    return change();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
