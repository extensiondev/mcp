// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { addWarning, patchValue } from "./act";
import { isChromiumFamily, isGeckoFamily } from "./browser-family";
import { resolveCdpPort, resolveRdpPort, rdpPortMissingReason } from "./cdp-port";
import { evaluateOnExtensionPage, readExtensionPageTargets } from "./cdp-extension-page";
import { listDocumentTargets, matchTargetsByUrl } from "./cdp-targets";
import { listBridgeTabs } from "./bridge-tabs";
import { rdpEvaluateInTab, rdpListTabs, type RdpTab } from "./rdp";
import { findGeckoTab } from "./target-pick";
import {
  elementListExpression,
  observeExpression,
  readElementList,
  readObservation,
  settleWaitWithin,
  SURFACE_CONTEXTS,
  type ElementList,
  type Observation,
} from "./element-list";

export type ObserveTarget =
  | { kind: "cdp"; port: number; targetId: string; url: string; label: string }
  | { kind: "rdp"; port: number; url: string; label: string }
  | { kind: "unavailable"; reason: string; label: string };

export interface ObservePick {
  projectPath: string;
  browser: string;
  context?: string;
  url?: string;
  tab?: number;
  targetId?: string;
  timeout?: number;
}

export interface SurfaceResolvers {
  surfaceDocument: (projectPath: string, browser: string, surface: string) => string | null;
  resolveExtensionId: (projectPath: string, browser: string) => Promise<string | null>;
}

export const OBSERVE_PROPERTY = {
  type: ["boolean", "string"],
  default: false,
  description:
    "true also answers value.observation: the surface's elements once it loaded and settled; a surface name (popup, options, sidebar...) reads that one.",
};

export type ObserveAsk = { on: false } | { on: true; context?: string; refused?: string };

export function observeAsked(observe: unknown): ObserveAsk {
  if (observe === true) return { on: true };
  if (typeof observe !== "string" || !observe) return { on: false };
  if (SURFACE_CONTEXTS.includes(observe)) return { on: true, context: observe };

  return { on: true, refused: `"${observe}" is not a surface this server reads; observe takes true or one of ${SURFACE_CONTEXTS.join(", ")}` };
}

const sameDocument = (a: unknown, b: string): boolean =>
  String(a ?? "").replace(/[?#].*$/, "") === b.replace(/[?#].*$/, "");

function geckoTabShowing<T extends { url?: string }>(tabs: T[], document: string): T | undefined {
  const wanted = document.replace(/^\.?\//, "").replace(/[?#].*$/, "");

  return tabs.find((tab) => /^moz-extension:\/\/[^/]+\/([^?#]*)/.exec(String(tab.url ?? ""))?.[1] === wanted);
}

function unavailable(reason: string, label: string): ObserveTarget {
  return { kind: "unavailable", reason, label };
}

function noDebugPort(browser: string, label: string): ObserveTarget {
  return unavailable(
    `${browser} exposes no debug port this server reads a page over, and the engine's inspect verb carries no element list`,
    label,
  );
}

async function chromiumTargetByUrl(pick: ObservePick, url: string, label: string): Promise<ObserveTarget> {
  const resolved = await resolveCdpPort(pick.projectPath, pick.browser, { timeoutMs: pick.timeout });
  if (!resolved) return unavailable("the session records no CDP port", label);

  let targets: Awaited<ReturnType<typeof listDocumentTargets>>;

  try {
    targets = await listDocumentTargets(resolved.port);
  } catch (err) {
    return unavailable(`the session's targets could not be listed (${err instanceof Error ? err.message : String(err)})`, label);
  }

  const exact = targets.filter((t) => t.url === url);
  const matches = exact.length ? exact : targets.filter((t) => sameDocument(t.url, url));
  const found = (matches.length ? matches : matchTargetsByUrl(targets, url))[0];
  if (!found) return unavailable(`no open page shows ${url}`, label);

  return { kind: "cdp", port: resolved.port, targetId: found.targetId, url: found.url, label };
}

async function geckoTabs(pick: ObservePick, label: string): Promise<{ port: number; tabs: RdpTab[] } | ObserveTarget> {
  const resolved = await resolveRdpPort(pick.projectPath, pick.browser, { waitMs: 1_000, graceMs: 500 });
  if (!resolved?.port) return unavailable(resolved ? rdpPortMissingReason(resolved) : "the session records no debugger (RDP) port", label);

  try {
    return { port: resolved.port, tabs: await rdpListTabs(resolved.port) };
  } catch (err) {
    return unavailable(`the debugger (RDP) port did not list tabs (${err instanceof Error ? err.message : String(err)})`, label);
  }
}

async function geckoTargetByUrl(pick: ObservePick, url: string, label: string): Promise<ObserveTarget> {
  const listed = await geckoTabs(pick, label);
  if ("kind" in listed) return listed;

  const tab =
    listed.tabs.find((t) => String(t.url ?? "") === url) ??
    listed.tabs.find((t) => sameDocument(t.url, url)) ??
    listed.tabs.find((t) => String(t.url ?? "").toLowerCase().includes(url.toLowerCase()));
  if (!tab) return unavailable(`no open tab shows ${url}`, label);

  return { kind: "rdp", port: listed.port, url: String(tab.url ?? ""), label };
}

async function targetByUrl(pick: ObservePick, url: string, label: string): Promise<ObserveTarget> {
  if (isChromiumFamily(pick.browser)) return chromiumTargetByUrl(pick, url, label);
  if (isGeckoFamily(pick.browser)) return geckoTargetByUrl(pick, url, label);

  return noDebugPort(pick.browser, label);
}

async function targetById(pick: ObservePick, targetId: string, label: string): Promise<ObserveTarget> {
  if (isChromiumFamily(pick.browser)) {
    const resolved = await resolveCdpPort(pick.projectPath, pick.browser, { timeoutMs: pick.timeout });
    if (!resolved) return unavailable("the session records no CDP port", label);

    try {
      const target = (await listDocumentTargets(resolved.port)).find((t) => t.targetId === targetId);
      if (!target) return unavailable(`no open page has targetId ${targetId}`, label);

      return { kind: "cdp", port: resolved.port, targetId, url: target.url, label };
    } catch (err) {
      return unavailable(`the session's targets could not be listed (${err instanceof Error ? err.message : String(err)})`, label);
    }
  }

  if (isGeckoFamily(pick.browser)) {
    const listed = await geckoTabs(pick, label);
    if ("kind" in listed) return listed;

    const tab = findGeckoTab(listed.tabs, targetId);
    if (!tab) return unavailable(`no open tab has targetId ${targetId}`, label);

    return { kind: "rdp", port: listed.port, url: String(tab.url ?? ""), label };
  }

  return noDebugPort(pick.browser, label);
}

async function surfaceTarget(pick: ObservePick, context: string, surfaces: SurfaceResolvers): Promise<ObserveTarget> {
  const label = `the ${context}`;
  const document = surfaces.surfaceDocument(pick.projectPath, pick.browser, context);
  if (!document) return unavailable(`the manifest declares no ${context} document`, label);

  if (isChromiumFamily(pick.browser)) {
    const resolved = await resolveCdpPort(pick.projectPath, pick.browser, { timeoutMs: pick.timeout });
    if (!resolved) return unavailable("the session records no CDP port", label);

    const extensionId = await surfaces.resolveExtensionId(pick.projectPath, pick.browser);
    if (!extensionId) return unavailable("the extension id could not be resolved from the session", label);

    const wanted = `chrome-extension://${extensionId}/${document}`;
    const read = await readExtensionPageTargets(resolved.port, wanted);
    if ("unreadable" in read) return unavailable(`the session's targets could not be listed (${read.unreadable})`, label);

    const target = read.targets[0];
    if (!target) return unavailable(`no open page shows ${wanted}`, label);

    return { kind: "cdp", port: resolved.port, targetId: target.targetId, url: target.url, label };
  }

  if (isGeckoFamily(pick.browser)) {
    const listed = await geckoTabs(pick, label);
    if ("kind" in listed) return listed;

    const tab = geckoTabShowing(listed.tabs, document);
    if (!tab) return unavailable(`no open tab shows ${document}`, label);

    return { kind: "rdp", port: listed.port, url: String(tab.url ?? ""), label };
  }

  return noDebugPort(pick.browser, label);
}

export async function resolveObserveTarget(pick: ObservePick, surfaces: SurfaceResolvers): Promise<ObserveTarget> {
  if (pick.targetId) return targetById(pick, pick.targetId, `targetId ${pick.targetId}`);

  if (pick.context && SURFACE_CONTEXTS.includes(pick.context)) return surfaceTarget(pick, pick.context, surfaces);

  if (pick.url) return targetByUrl(pick, pick.url, pick.url);

  if (typeof pick.tab === "number") {
    const label = `tab ${pick.tab}`;
    const listed = await listBridgeTabs(pick.projectPath, pick.browser, pick.timeout);
    if ("error" in listed) return unavailable("the open tabs could not be listed over the control channel", label);

    const tab = listed.tabs.find((t) => t.tabId === pick.tab);
    if (!tab) return unavailable(`no open tab has id ${pick.tab}`, label);

    return targetByUrl(pick, tab.url, label);
  }

  return unavailable("no surface, url, tab or targetId names what to observe", "the surface");
}

type ProtocolRead = { ok: true; value: unknown } | { ok: false; message: string };

async function evaluateOnTarget(target: ObserveTarget, expression: string, timeoutMs?: number): Promise<ProtocolRead> {
  if (target.kind === "unavailable") return { ok: false, message: target.reason };

  try {
    if (target.kind === "cdp") {
      const outcome = await evaluateOnExtensionPage(target.port, target.targetId, expression, timeoutMs);

      return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, message: outcome.message };
    }

    const url = target.url;
    const outcome = await rdpEvaluateInTab(target.port, {
      select: (tabs) => tabs.find((t) => String(t.url ?? "") === url) ?? tabs.find((t) => sameDocument(t.url, url)),
      expression,
      timeoutMs: timeoutMs ?? 10_000,
    });

    return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, message: outcome.message };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export type ElementsRead = { list: ElementList; target: ObserveTarget } | { unavailable: string; target: ObserveTarget };

export async function readElementsOn(target: ObserveTarget, timeoutMs?: number): Promise<ElementsRead> {
  const read = await evaluateOnTarget(target, elementListExpression(), timeoutMs);
  if (!read.ok) return { unavailable: read.message, target };

  const list = readElementList(read.value);

  return list ? { list, target } : { unavailable: "the page answered the element read with a value this server could not read as a list", target };
}

export type ObservationRead = { observation: Observation; waitedMs: number; target: ObserveTarget } | { unavailable: string; target: ObserveTarget };

export async function readObservationOn(target: ObserveTarget, timeoutMs?: number): Promise<ObservationRead> {
  const waitMs = settleWaitWithin(timeoutMs);
  const read = await evaluateOnTarget(target, observeExpression(waitMs), timeoutMs);
  if (!read.ok) return { unavailable: read.message, target };

  const observation = readObservation(read.value);

  return observation
    ? { observation, waitedMs: waitMs, target }
    : { unavailable: "the page answered the observe read with a value this server could not read as an observation", target };
}

export function snapshotCallFor(target: ObserveTarget, context?: string): string {
  if (target.kind === "cdp") return `extension_dom_snapshot {targetId: "${target.targetId}", include: ["elements"]}`;
  if (context && SURFACE_CONTEXTS.includes(context)) return `extension_dom_snapshot {context: "${context}", include: ["elements"]}`;

  return 'extension_dom_snapshot {include: ["elements"]}';
}

export function attachObservation(frame: Record<string, any>, read: ObservationRead, context?: string): void {
  if ("unavailable" in read) {
    patchValue(frame, { observation: null });
    addWarning(
      frame,
      `observe: true could not read ${read.target.label}: ${read.unavailable}. Read it once it is open with ${snapshotCallFor(read.target, context)}.`,
    );

    return;
  }

  patchValue(frame, { observation: read.observation });

  if (!read.observation.settled) {
    addWarning(
      frame,
      `observation.settled is false: ${read.target.label} was still loading or had finite animations running ${read.waitedMs} ms after the act, so the list may still change. Read it again with ${snapshotCallFor(read.target, context)}.`,
    );
  }
}

export async function observeAfterAct(
  frame: Record<string, any>,
  ask: ObserveAsk,
  pick: ObservePick,
  surfaces: SurfaceResolvers,
): Promise<void> {
  if (!ask.on || !frame || frame.ok !== true) return;

  if (ask.refused) {
    attachObservation(frame, { unavailable: ask.refused, target: unavailable(ask.refused, "the surface") }, pick.context);

    return;
  }

  const chosen = ask.context ? { ...pick, context: ask.context, url: undefined, tab: undefined, targetId: undefined } : pick;
  const target = await resolveObserveTarget(chosen, surfaces);
  attachObservation(frame, await readObservationOn(target, pick.timeout), chosen.context);
}
