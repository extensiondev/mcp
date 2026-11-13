// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

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
    publish: 'Firefox has no publish act; AMO reviews a Firefox version when it is submitted. Leave firefox out of publish, and submit the version with extension_submit (browsers: ["firefox"], dryRun: false).',
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
