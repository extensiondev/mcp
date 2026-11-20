// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { AsyncLocalStorage } from "node:async_hooks";

import { envelope, type Envelope, type EnvelopeInit } from "./envelope";

interface CallRefusals {
  composed: Set<string>;
  relayed: boolean;
}

const scope = new AsyncLocalStorage<CallRefusals>();

function refusalKey(frame: Pick<Envelope, "error">): string {
  return `${String(frame.error?.code ?? "").length}:${frame.error?.code ?? ""}${frame.error?.message ?? ""}`;
}

export function withComposedRefusals<T>(run: () => T): T {
  return scope.run({ composed: new Set(), relayed: false }, run);
}

export function composedRefusal(init: EnvelopeInit): string {
  const text = envelope(init);

  if (init.ok === false) scope.getStore()?.composed.add(refusalKey(JSON.parse(text) as Envelope));

  return text;
}

export function relayedAnswer(): void {
  const call = scope.getStore();
  if (call) call.relayed = true;
}

export function composedInThisCall(frame: Envelope): boolean {
  const call = scope.getStore();

  return call !== undefined && !call.relayed && call.composed.has(refusalKey(frame));
}
