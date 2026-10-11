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
