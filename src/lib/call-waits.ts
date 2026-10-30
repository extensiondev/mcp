// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { AsyncLocalStorage } from "node:async_hooks";

import { annotate } from "./tool-frames";

interface CallWaits {
  lines: string[];
}

const storage = new AsyncLocalStorage<CallWaits>();

export async function withCallWaits(call: () => Promise<string>): Promise<string> {
  const waits: CallWaits = { lines: [] };
  const answer = await storage.run(waits, call);

  return waits.lines.reduce((text, line) => annotate(text, { warning: line }), answer);
}

export function noteCallWait(line: string): boolean {
  const waits = storage.getStore();
  if (!waits) return false;

  if (!waits.lines.includes(line)) waits.lines.push(line);

  return true;
}
