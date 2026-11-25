// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { AsyncLocalStorage } from "node:async_hooks";

export const PROGRESS_HEARTBEAT_MS = 5_000;

export type ProgressToken = string | number;

export interface ProgressNotice {
  method: "notifications/progress";
  params: { progressToken: ProgressToken; progress: number; message?: string };
}

interface CallProgress {
  token: ProgressToken;
  send: (notice: ProgressNotice) => Promise<void>;
  count: number;
  phase: string;
}

const storage = new AsyncLocalStorage<CallProgress>();

/* @invariant A CALL THAT ASKED FOR PROGRESS HEARS WHAT IT IS WAITING ON, AND
 * A CALL THAT DID NOT HEARS NOTHING. Builds, sessions, browser downloads and
 * the hosted lane's waits run for tens of seconds in one call, and a client
 * that sent _meta.progressToken had no sign of life until the answer
 * (ledger 1146). When the token is there, each phase a long tool enters is
 * sent as notifications/progress with a rising progress count and the phase
 * as its message, and while a phase lasts a heartbeat repeats it every
 * PROGRESS_HEARTBEAT_MS with the seconds spent, so a client that resets its
 * timeout on progress keeps waiting. Without a token nothing is sent and
 * nothing is timed. A notification that cannot be sent never fails the call.
 */
export async function withCallProgress<T>(
  token: ProgressToken | undefined,
  send: (notice: ProgressNotice) => Promise<void>,
  call: () => Promise<T>,
): Promise<T> {
  if (token === undefined || token === null) return call();

  const progress: CallProgress = { token, send, count: 0, phase: "" };
  const started = Date.now();
  const heartbeat = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    emit(progress, progress.phase ? `${progress.phase} (${seconds} s)` : `Working (${seconds} s)`);
  }, PROGRESS_HEARTBEAT_MS);

  heartbeat.unref?.();

  try {
    return await storage.run(progress, call);
  } finally {
    clearInterval(heartbeat);
  }
}

export function reportProgress(phase: string): boolean {
  const progress = storage.getStore();
  if (!progress) return false;

  progress.phase = phase;
  emit(progress, phase);

  return true;
}

function emit(progress: CallProgress, message: string): void {
  progress.count += 1;

  try {
    progress.send({ method: "notifications/progress", params: { progressToken: progress.token, progress: progress.count, message } }).catch(() => undefined);
  } catch {
    progress.count -= 1;
  }
}
