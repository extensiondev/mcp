// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const FIRST_CALL_POLL_MS = 8_000;
export const RESUME_POLL_MS = 15_000;
export const START_WORK_WITHIN_MS = 20_000;
export const ANSWER_WITHIN_MS = 45_000;
export const CREATE_REQUEST_MS = 90_000;
export const CREATE_READ_BACK_MS = 15_000;

export function answerDeadline(callStartedAt: number): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const leftMs = Math.max(1_000, callStartedAt + ANSWER_WITHIN_MS - Date.now());
  const timer = setTimeout(() => {
    controller.abort(
      new Error(
        `no answer within ${Math.round(leftMs / 1000)} s; the request was abandoned so this call answers before the 60 s request timeout most MCP clients apply`,
      ),
    );
  }, leftMs);
  timer.unref?.();

  return { signal: controller.signal, release: () => clearTimeout(timer) };
}

export function createRequestDeadline(
  callStartedAt: number,
  callBlocks: boolean,
): { signal: AbortSignal; release: () => void } {
  const windowSpent = Date.now() - callStartedAt >= ANSWER_WITHIN_MS;

  if (!callBlocks && !windowSpent) return answerDeadline(callStartedAt);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error(
        `no answer within ${Math.round(CREATE_REQUEST_MS / 1000)} s of sending the create, the time this call gives a create once it already blocks past the 45 s answer window`,
      ),
    );
  }, CREATE_REQUEST_MS);
  timer.unref?.();

  return { signal: controller.signal, release: () => clearTimeout(timer) };
}

export async function readBackOnce(send: (signal: AbortSignal) => Promise<Response>): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("read-back timed out")), CREATE_READ_BACK_MS);
  timer.unref?.();

  try {
    return await send(controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
