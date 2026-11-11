// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CDP_PORT_MISSING_HINT } from "../lib/cdp-port";
import { readExtensionPageTargets } from "../lib/cdp-extension-page";
import { listPageTargets, matchTargetsByUrl, TARGET_ID_NOTE } from "../lib/cdp-targets";
import { envelope, type EnvelopeInit } from "../lib/envelope";
import { EXTENSION_PAGE_CONTEXTS, distinctUrls } from "../lib/extension-surfaces";
import {
  AMBIGUOUS_TARGET_HINT,
  identicalPickWarning,
  pickTarget,
  targetNotFound,
  type TargetRef,
} from "../lib/target-pick";
import { resolveExtensionId, surfaceDocument, SURFACE_MANIFEST_KEYS } from "./open";

const COMMAND = "extension_element";

const BROWSER_ERROR_PAGE = /^(chrome|edge)-error:\/\//;

const isBrowserErrorPage = (url: string): boolean => BROWSER_ERROR_PAGE.test(url);

const refuse = (init: Omit<EnvelopeInit, "ok" | "command">): string => envelope({ ok: false, command: COMMAND, ...init });

export interface TargetArgs {
  projectPath: string;
  context?: string;
  url?: string;
  targetId?: string;
}

const pageRef = (t: { targetId: string; url: string }): TargetRef => ({ targetId: t.targetId, url: t.url });

export type Picked = { target: TargetRef; where: string; warnings: Array<string | null> };

async function pickByTargetId(port: number, args: TargetArgs, browser: string, targetId: string): Promise<Picked | string> {
  let live: TargetRef[];

  try {
    live = (await listPageTargets(port)).map(pageRef);
  } catch (err) {
    return targetsUnreadable(err instanceof Error ? err.message : String(err));
  }

  const target = live.find((t) => t.targetId === targetId);
  if (!target) return targetNotFound(COMMAND, targetId, live, { projectPath: args.projectPath, browser });

  return { target, where: `${target.url} (targetId ${targetId})`, warnings: [] };
}

async function pickByUrl(port: number, url: string): Promise<Picked | string> {
  let matches: Array<{ targetId: string; url: string; title: string }>;

  try {
    matches = matchTargetsByUrl(await listPageTargets(port), url).filter((t) => !isBrowserErrorPage(t.url));
  } catch (err) {
    return targetsUnreadable(err instanceof Error ? err.message : String(err));
  }

  if (matches.length === 0) {
    return refuse({
      status: "no-matching-target",
      error: {
        code: "E_NO_MATCHING_TARGET",
        name: "NoMatchingTarget",
        message: `No open page's url (or title) matches "${url}", so there is no document to act in.`,
      },
      hint: `Open the page first with extension_open (url), or pass a url that matches one open tab; extension_dom_snapshot with listTargets: true lists what is open. ${TARGET_ID_NOTE}`,
    });
  }

  const pick = pickTarget(matches, pageRef);

  if (pick.kind === "different") {
    return refuse({
      status: "ambiguous-target",
      error: {
        code: "E_AMBIGUOUS_TARGET",
        name: "AmbiguousTabUrl",
        message: `url: ${url} matches ${matches.length} open tabs that show different pages (${distinctUrls(matches).join(", ")}); refusing to guess which one you mean, so nothing was done.`,
      },
      value: { matchingTargets: matches.map(pageRef) },
      hint: AMBIGUOUS_TARGET_HINT,
    });
  }

  const target = pick.kind === "one" ? pick.target : matches[0];

  return {
    target: pageRef(target),
    where: `${target.url} (targetId ${target.targetId})`,
    warnings: [pick.kind === "one" ? identicalPickWarning(pageRef(target), pick.others.map(pageRef), "chromium") : null],
  };
}

async function pickSurface(port: number, args: TargetArgs, browser: string, context: string): Promise<Picked | string> {
  const document = surfaceDocument(args.projectPath, browser, context);

  if (!document) {
    const key = SURFACE_MANIFEST_KEYS[context] ?? context;

    return refuse({
      status: "no-surface",
      error: {
        code: "E_NO_SURFACE_DOCUMENT",
        name: "NoSurfaceDocument",
        message: `This extension declares no ${context}: nothing in its manifest sets ${key}, so there is no ${context} page to act in.`,
      },
      hint: `To add one, set ${key} in the manifest and rebuild.`,
    });
  }

  const extensionId = await resolveExtensionId(args.projectPath, browser);

  if (!extensionId) {
    return refuse({
      status: "no-extension-id",
      error: {
        code: "E_NO_EXTENSION_ID",
        name: "NoExtensionId",
        message: "Could not resolve the extension id from the live session's CDP targets.",
      },
      hint: `Confirm the session is ready (extension_wait). ${CDP_PORT_MISSING_HINT}`,
    });
  }

  const wanted = `chrome-extension://${extensionId}/${document}`;
  const read = await readExtensionPageTargets(port, wanted);
  if ("unreadable" in read) return targetsUnreadable(read.unreadable);

  const targets = read.targets.filter((t) => !isBrowserErrorPage(t.url));

  if (targets.length === 0) {
    return refuse({
      status: "no-target",
      error: {
        code: "E_NO_TARGET",
        name: "NoTarget",
        message: `No open page at ${wanted}, so there is no ${context} to act in; a surface has a target only while it is open.`,
      },
      value: { wanted },
      hint: `Open it first with extension_open surface: "${context}", then call extension_element again. extension_dom_snapshot with listTargets: true lists what is open.`,
    });
  }

  const target = targets[0];

  return {
    target: pageRef(target),
    where: `the ${context} (${target.url}, targetId ${target.targetId})`,
    warnings: [identicalPickWarning(pageRef(target), targets.slice(1).map(pageRef), "chromium")],
  };
}

function targetsUnreadable(why: string): string {
  return refuse({
    status: "targets-unreadable",
    error: {
      code: "E_CDP",
      name: "TargetsUnreadable",
      message: `Could not list the session's CDP targets: ${why}. Nothing was done.`,
    },
    hint: "The session's debug port did not answer. extension_doctor says whether the browser is still up; if it is, retry.",
  });
}

export async function pickTargetFor(port: number, args: TargetArgs, browser: string): Promise<Picked | string> {
  if (args.targetId) return pickByTargetId(port, args, browser, args.targetId);

  const context = args.context ?? (args.url ? "page" : undefined);

  if (context === "page") {
    if (args.url) return pickByUrl(port, args.url);

    return refuse({
      status: "bad-request",
      error: {
        code: "E_BAD_REQUEST",
        name: "BadRequest",
        message: 'context: "page" needs the tab named: pass url (a substring or * glob of its address) or targetId.',
      },
      hint: "extension_dom_snapshot with listTargets: true lists the open pages with their targetId.",
    });
  }

  if (context && EXTENSION_PAGE_CONTEXTS.includes(context)) return pickSurface(port, args, browser, context);

  return refuse({
    status: "bad-request",
    error: {
      code: "E_BAD_REQUEST",
      name: "BadRequest",
      message: "No element target named: pass context (an open surface such as popup or options), url for a web page, or targetId.",
    },
    hint: `Surfaces: ${EXTENSION_PAGE_CONTEXTS.join(", ")}. extension_dom_snapshot with listTargets: true lists what is open.`,
  });
}
