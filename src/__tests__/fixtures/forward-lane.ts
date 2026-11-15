// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { afterEach, beforeEach, vi } from "vitest";

import { envelope } from "../../lib/envelope";
import { EXCHANGE_PATH, FORWARD_PATH, forgetForwardCredentials } from "../../lib/forward-credential";
import { forgetCarriedMemory } from "../../lib/forward-lane-answer";
import { forgetApprovalHolders } from "../../lib/hosted-forwarder";

type Row = Record<string, unknown>;

export interface LaneHit {
  url: string;
  path: string;
  method: string;
  authorization: string;
  project: string;
  tool: string;
  args: Row;
  body: Row | null;
}

export type LaneReply = Row | Response | undefined;

export interface ForwardLane {
  seen: LaneHit[];
  answer: (hit: LaneHit) => LaneReply;
  door: (hit: LaneHit) => LaneReply;
  exchanged(): string[];
  lane(): LaneHit[];
  sentAnything(): boolean;
}

export const forwardOf = (login: string): string => `Bearer forward-of-${login}`;

/* @invariant THE LANE IS STUBBED AT THE NETWORK, SO WHAT A CELL READS IS WHAT
 * LEFT THE MACHINE. A platform tool no longer runs in this package: the call
 * is bound to a project and a stored login here, that login is exchanged at
 * www for a forward credential, and the bound call goes to the hosted lane.
 * This fixture answers the exchange with a credential that names the login
 * it was minted from and answers the lane with an empty success, so a cell
 * asserts the binding by the login that was exchanged, the project header
 * and the arguments the lane received, and by nothing leaving at all for a
 * call refused here. A cell that needs another lane answer or a www door
 * sets answer or door.
 */
export function useForwardLane(): ForwardLane {
  const stage: ForwardLane = {
    seen: [],
    answer: () => undefined,
    door: () => undefined,
    exchanged: () => stage.seen.filter((hit) => hit.path === EXCHANGE_PATH).map((hit) => hit.authorization),
    lane: () => stage.seen.filter((hit) => hit.path === FORWARD_PATH),
    sentAnything: () => stage.seen.length > 0,
  };
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const replied = (reply: LaneReply, fallback: () => Response): Response => (reply instanceof Response ? reply : reply ? json(reply) : fallback());

  beforeEach(() => {
    stage.seen.length = 0;
    stage.answer = () => undefined;
    stage.door = () => undefined;
    forgetForwardCredentials();
    forgetApprovalHolders();
    forgetCarriedMemory();

    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const headers = new Headers(init?.headers);
      let body: Row | null = null;

      try {
        body = typeof init?.body === "string" ? (JSON.parse(init.body) as Row) : null;
      } catch {
        body = null;
      }

      const hit: LaneHit = {
        url: url.toString(),
        path: url.pathname,
        method: String(init?.method ?? "GET").toUpperCase(),
        authorization: headers.get("authorization") ?? "",
        project: headers.get("x-extensiondev-project") ?? "",
        tool: String(body?.tool ?? ""),
        args: (body?.args as Row | undefined) ?? {},
        body,
      };

      stage.seen.push(hit);

      if (hit.path === EXCHANGE_PATH) return replied(stage.door(hit), () => json({ access_token: `forward-of-${hit.authorization.replace(/^Bearer /, "")}`, expires_in: 600 }));
      if (hit.path === FORWARD_PATH) return replied(stage.answer(hit), () => json(JSON.parse(envelope({ ok: true, command: hit.tool, status: "answered", value: {} }))));

      return replied(stage.door(hit), () => json({ code: "NOT_FOUND", message: "not found" }, 404));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    forgetForwardCredentials();
    forgetApprovalHolders();
    forgetCarriedMemory();
  });

  return stage;
}
