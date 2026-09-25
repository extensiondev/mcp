// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant The surface relay inside the extension evaluates synchronously
   and hands sendResponse whatever the expression returned. A promise is not a
   cloneable value: Chrome's relay falls back to String(value) and answers
   "[object Promise]", Firefox reports the clone failure to the sender as no
   response at all, and the bridge then calls the surface "not open" while the
   page is still running the expression (measured 2026-09-25, Firefox Nightly
   158, ledger entry 5). So nothing thenable ever reaches sendResponse: the
   wrapper below settles it inside the page, parks the outcome under a token,
   and hands back a small cloneable frame the caller polls for. A value that
   cannot be cloned is stringified in the page, where that is a choice rather
   than a lost reply. */

export const RELAY_MARK = "__extensionDevRelay";

export interface RelayFrame {
  done: boolean;
  ok?: boolean;
  value?: unknown;
  name?: string;
  message?: string;
  token?: string;
}

function cloneHelper(): string {
  return `var clone = function (v) {
    if (v === undefined) return null;
    try {
      if (typeof structuredClone === "function") { structuredClone(v); return v; }
      return JSON.parse(JSON.stringify(v));
    } catch (e) { return String(v); }
  };`;
}

export function relaySafeExpression(expression: string, token: string): string {
  const src = JSON.stringify(expression);
  const key = JSON.stringify(token);
  return `(function () {
  ${cloneHelper()}
  var value = (0, eval)(${src});
  if (value && typeof value.then === "function") {
    var store = globalThis.${RELAY_MARK} = globalThis.${RELAY_MARK} || {};
    store[${key}] = { done: false };
    Promise.resolve(value).then(function (settled) {
      store[${key}] = { done: true, ok: true, value: clone(settled) };
    }, function (error) {
      store[${key}] = { done: true, ok: false, name: (error && error.name) || "EvalError", message: (error && error.message) || String(error) };
    });
    return { ${RELAY_MARK}: 1, done: false, token: ${key} };
  }
  return { ${RELAY_MARK}: 1, done: true, ok: true, value: clone(value) };
})()`;
}

export function relayPollExpression(token: string): string {
  const key = JSON.stringify(token);
  return `(function () {
  var store = globalThis.${RELAY_MARK};
  var entry = store && store[${key}];
  if (!entry) return { ${RELAY_MARK}: 1, done: true, ok: false, name: "RelayLost", message: "the page reloaded or navigated before the expression settled, so its result is gone" };
  if (!entry.done) return { ${RELAY_MARK}: 1, done: false, token: ${key} };
  delete store[${key}];
  return { ${RELAY_MARK}: 1, done: true, ok: entry.ok, value: entry.value, name: entry.name, message: entry.message };
})()`;
}

export function readRelayFrame(value: unknown): RelayFrame | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (frame[RELAY_MARK] !== 1 || typeof frame.done !== "boolean") return null;
  return {
    done: frame.done,
    ...(typeof frame.ok === "boolean" ? { ok: frame.ok } : {}),
    ...("value" in frame ? { value: frame.value } : {}),
    ...(typeof frame.name === "string" ? { name: frame.name } : {}),
    ...(typeof frame.message === "string" ? { message: frame.message } : {}),
    ...(typeof frame.token === "string" ? { token: frame.token } : {}),
  };
}
