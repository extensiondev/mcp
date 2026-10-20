// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";
import { readReloadEvidence, rememberedExtensionTargetUrl, type SessionRef } from "./extension-reload";

export interface TargetRef {
  targetId: string;
  url: string;
}

export type TargetPick<T> =
  | { kind: "none" }
  | { kind: "one"; target: T; others: T[] }
  | { kind: "different"; candidates: T[] };

export type TargetFamily = "chromium" | "gecko";

export const TARGET_ID_PROPERTY = {
  type: "string",
  description:
    "Pick one open page directly by its targetId: the target.targetId extension_open answers, or a targetId from extension_dom_snapshot listTargets: true (a CDP target id on Chromium, the tab's browserId on Firefox). When given, `url` is ignored. A target that is gone is refused with E_TARGET_NOT_FOUND, naming the live ones.",
};

export const AMBIGUOUS_TARGET_HINT =
  "Pass `targetId` with the targetId of the one you mean from matchingTargets, or a url that matches only that page (its #fragment included).";

interface GeckoTabLike {
  actor?: string;
  url?: string;
  selected?: boolean;
  browserId?: number;
}

export function geckoTargetId(tab: GeckoTabLike): string {
  return typeof tab.browserId === "number" ? String(tab.browserId) : String(tab.actor ?? "");
}

export function geckoTabRef(tab: GeckoTabLike): TargetRef {
  return { targetId: geckoTargetId(tab), url: String(tab.url ?? "") };
}

export function findGeckoTab<T extends GeckoTabLike>(tabs: T[], targetId: string): T | undefined {
  return tabs.find((tab) => geckoTargetId(tab) === targetId || tab.actor === targetId);
}

export function geckoRecency(a: GeckoTabLike, b: GeckoTabLike): number {
  if ((a.selected === true) !== (b.selected === true)) return a.selected === true ? -1 : 1;

  return (typeof b.browserId === "number" ? b.browserId : -1) - (typeof a.browserId === "number" ? a.browserId : -1);
}

export function pickTarget<T>(
  matches: T[],
  ref: (target: T) => TargetRef,
  rank?: (a: T, b: T) => number,
): TargetPick<T> {
  if (matches.length === 0) return { kind: "none" };
  if (new Set(matches.map((m) => ref(m).url)).size > 1) return { kind: "different", candidates: matches };

  const ordered = rank ? [...matches].sort(rank) : matches;

  return { kind: "one", target: ordered[0], others: ordered.slice(1) };
}

export function identicalPickWarning(picked: TargetRef, others: TargetRef[], family: TargetFamily): string | null {
  if (others.length === 0) return null;

  const rule =
    family === "chromium"
      ? "the most recently active one (Chromium lists its targets by last activity)"
      : "the selected tab, else the most recently created one";

  return `${others.length + 1} open tabs show ${picked.url}; this used targetId ${picked.targetId}, ${rule}. The others: ${others.map((o) => o.targetId).join(", ")}. Pass targetId to pick another.`;
}

export function targetNotFound(command: string, targetId: string, live: TargetRef[], session?: SessionRef): string {
  const liveList = live.length ? live.map((t) => `${t.targetId} (${t.url})`).join(", ") : "none";
  const reload = session ? readReloadEvidence(session.projectPath, session.browser) : null;
  const openedUrl = reload ? rememberedExtensionTargetUrl(targetId) : null;
  const message = openedUrl
    ? `No open target has targetId ${targetId}: it showed ${openedUrl}, one of the extension's own pages, and the extension reloaded (${reload!.sentence}). Chrome closes an extension's pages when it reloads, so that tab is gone. Live targets: ${liveList}.`
    : reload
      ? `No open target has targetId ${targetId}; it was closed or never belonged to this session. The extension reloaded (${reload.sentence}), and Chrome closes an extension's pages when it reloads, so if that tab showed one of them it is gone. Live targets: ${liveList}.`
      : `No open target has targetId ${targetId}; it was closed or never belonged to this session. Live targets: ${liveList}.`;

  return envelope({
    ok: false,
    command,
    status: "target-not-found",
    error: {
      code: "E_TARGET_NOT_FOUND",
      name: "TargetNotFound",
      message,
    },
    value: { liveTargets: live, ...(reload ? { extensionReloaded: { kind: reload.kind, at: reload.at } } : {}) },
    hint: reload
      ? "Open the page again with extension_open (the same url or surface) and use the targetId it answers; that id is new after every reload. extension_dom_snapshot with listTargets: true lists what is open."
      : "Pass one of liveTargets as targetId, or pass url instead. extension_dom_snapshot with listTargets: true lists what is open.",
  });
}
