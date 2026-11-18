// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { RdpSession } from "../../lib/rdp";

const asked = new Set<string>();
const request = RdpSession.prototype.request;

RdpSession.prototype.request = function (this: RdpSession, actor, packet, timeoutMs) {
  if (packet.type === "evaluateJSAsync" && typeof packet.text === "string") asked.add(packet.text);

  return request.call(this, actor, packet, timeoutMs);
};

export function askedEvaluateText(wire: unknown): string {
  for (const text of asked) {
    if (text === wire) return text;
  }

  throw new Error(`The fake debugger was sent text no RdpSession of this process asked it to evaluate: ${String(wire).slice(0, 120)}`);
}
