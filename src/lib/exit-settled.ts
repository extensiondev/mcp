// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type { ChildProcess } from "node:child_process";

export const REFUSED_EXIT_WAIT_MS = 1500;

/* @invariant A REFUSAL IS ANSWERED WITH THE ENGINE'S OWN FATE. An engine
 * that stamps a refusal often exits right after it, and the contract can be
 * read before the exit is recorded; so when the wait failed and the child
 * still looks alive, the answer waits for its exit event, at most
 * REFUSED_EXIT_WAIT_MS, before it says whether anything is running.
 */
export async function exitSettled(child: Pick<ChildProcess, "exitCode" | "signalCode" | "once" | "off">, ms: number = REFUSED_EXIT_WAIT_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    const state: { timer?: ReturnType<typeof setTimeout> } = {};

    const done = () => {
      clearTimeout(state.timer);
      child.off("exit", done);
      resolve();
    };

    state.timer = setTimeout(done, ms);
    state.timer.unref?.();
    child.once("exit", done);
  });
}
