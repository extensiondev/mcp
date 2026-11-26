// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";

export const STORE_ACT_NOT_ON_LANE_CODE = "STORE_ACT_NOT_ON_LANE";

export interface StoreActByHand {
  handPath?: string;
  handUrl?: string;
}

export interface ByHandStep {
  kind: "dashboard";
  say: string;
  url: string | null;
}

export interface ByHandFields {
  owner: "store";
  handPath?: string;
  handUrl?: string;
  sayToPerson: string;
  nextStep: ByHandStep;
}

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const closed = (sentence: string): string => (!sentence || /[.!?]$/.test(sentence) ? sentence : `${sentence}.`);

export function offLaneHandOf(code: unknown, body: unknown): StoreActByHand | null {
  if (str(code) !== STORE_ACT_NOT_ON_LANE_CODE) return null;

  const row = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const handPath = str(row.handPath);
  if (!handPath) return null;

  const handUrl = str(row.handUrl);

  return { handPath, ...(handUrl ? { handUrl } : {}) };
}

const OFF_LANE_TRUTHS: Record<string, Record<string, string>> = {
  firefox: {
    publish: 'Firefox has no publish act; Mozilla reviews a Firefox version when it is submitted. Leave firefox out of publish, and submit the version with extension_submit (browsers: ["firefox"], dryRun: false).',
  },
};

export function offLaneTruthOf(code: unknown, body: unknown): string | null {
  if (str(code) !== STORE_ACT_NOT_ON_LANE_CODE) return null;

  const row = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  return OFF_LANE_TRUTHS[str(row.store)]?.[str(row.act)] ?? null;
}

export function byHandSentence(message: string, hand: StoreActByHand): string {
  const said = closed(str(message));
  if (!hand.handPath || said.includes(hand.handPath)) return said;

  return `${said ? `${said} ` : ""}To do it now, ${hand.handPath}.`;
}

export function byHandFields(say: string, hand: StoreActByHand): ByHandFields {
  return {
    owner: "store",
    ...(hand.handPath ? { handPath: hand.handPath } : {}),
    ...(hand.handUrl ? { handUrl: hand.handUrl } : {}),
    sayToPerson: say,
    nextStep: { kind: "dashboard", say, url: hand.handUrl || null },
  };
}

/* @invariant AN ACT ONLY ONE STORE HAS IS NAMED BY HAND FROM THE SAME READ.
 * The Chrome rollout raise, the App Store release and the Safari signing
 * mint ride the submissions read under the rule a submit and a cancel do
 * (ledger 573): when the platform marks one `onPlatform: false`, the call
 * answers the store's own hand path as its next step, before an approval
 * is asked and before the route that would answer 409 (ledger 734). A read
 * that carries no verdict for the act leaves it to the route.
 */
export function storeActByHandAnswer(args: { command: string; action: string; store: string; subject: string; hand: StoreActByHand; value?: Record<string, unknown> }): string {
  const refused = `${args.subject} does not run on the extension.dev platform yet, so nothing was sent and no approval was asked for.`;
  const say = args.hand.handPath ? byHandSentence(refused, args.hand) : `${refused} Do it in the store's own dashboard.`;

  return envelope({
    ok: false,
    command: args.command,
    status: `${args.action}-by-hand`,
    value: { action: args.action, store: args.store, ...args.value, refusedBeforeApproval: true, ...byHandFields(say, args.hand) },
    error: { code: "E_PLATFORM", name: "StoreActNotOnPlatform", message: say },
    hint: say,
  });
}
