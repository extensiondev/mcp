// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const pending: string[] = [];

/* @invariant A FACT LEARNED WHILE OPENING A LOGIN REACHES THE ANSWER THAT
 * LOGIN PRODUCES. The credential layer learns things no tool asked about (a
 * stored login moved with its renamed project) and has no envelope of its own
 * to say them in; every tool builds its own. A warning deferred here is taken
 * by the next envelope built in this process, once, so the sentence lands in
 * the answer of the call that triggered it and is never repeated.
 */
export function deferWarning(text: string): void {
  const line = String(text || "").trim();
  if (line && !pending.includes(line)) pending.push(line);
}

export function takeDeferredWarnings(): string[] {
  return pending.splice(0, pending.length);
}
