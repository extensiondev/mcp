// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CDPClient } from "./cdp";

const PROBED_TYPES = new Set(["page", "iframe"]);
const MAX_PROBED_TARGETS = 12;

export interface PausedPage {
  targetId: string;
  url: string;
  reason: string;
  at?: string;
}

export interface PausedDiagnosis {
  targetId: string;
  url: string;
  samePage: boolean;
  pausedPages: PausedPage[];
  devtoolsOpen: number;
}

interface ListedTarget {
  id: string;
  type: string;
  url: string;
}

function pauseLocation(params: Record<string, unknown>): string | undefined {
  const frames = Array.isArray(params.callFrames) ? (params.callFrames as Array<Record<string, any>>) : [];
  const top = frames[0];
  if (!top) return undefined;

  const where = typeof top.url === "string" && top.url ? top.url : "an inline script";
  const line = typeof top.location?.lineNumber === "number" ? `:${top.location.lineNumber + 1}` : "";
  const fn = typeof top.functionName === "string" && top.functionName ? ` in ${top.functionName}` : "";

  return `${where}${line}${fn}`;
}

async function pausedAt(cdp: CDPClient, target: ListedTarget): Promise<PausedPage | null> {
  try {
    const sessionId = await cdp.attachToTarget(target.id);
    const params = await cdp.debuggerPause(sessionId);
    if (!params) return null;

    const at = pauseLocation(params);

    return {
      targetId: target.id,
      url: target.url,
      reason: typeof params.reason === "string" ? params.reason : "other",
      ...(at ? { at } : {}),
    };
  } catch {
    return null;
  }
}

export async function diagnosePausedTarget(port: number, targetId: string): Promise<PausedDiagnosis | null> {
  let listed: ListedTarget[];

  try {
    listed = (await CDPClient.discoverTargets(port)).map((t) => ({
      id: String(t.id),
      type: String(t.type),
      url: String(t.url ?? ""),
    }));
  } catch {
    return null;
  }

  const evaluated = listed.find((t) => t.id === targetId);
  if (!evaluated) return null;

  const devtoolsOpen = listed.filter((t) => t.url.startsWith("devtools://")).length;
  const others = listed
    .filter((t) => t.id !== targetId && PROBED_TYPES.has(t.type) && !t.url.startsWith("devtools://"))
    .slice(0, MAX_PROBED_TARGETS);
  const cdp = new CDPClient();

  try {
    await cdp.connect(await CDPClient.discoverBrowserWsUrl(port));

    const own = await pausedAt(cdp, evaluated);
    const pausedPages = own ? [own] : (await Promise.all(others.map((t) => pausedAt(cdp, t)))).filter((p): p is PausedPage => p !== null);

    if (pausedPages.length === 0) return null;

    return { targetId, url: evaluated.url, samePage: Boolean(own), pausedPages, devtoolsOpen };
  } catch {
    return null;
  } finally {
    try {
      cdp.disconnect();
    } catch {
    }
  }
}

export function pausedSentence(diagnosis: PausedDiagnosis): string {
  const pages = diagnosis.pausedPages
    .map((p) => `${p.url} (targetId ${p.targetId}, reason "${p.reason}"${p.at ? `, stopped at ${p.at}` : ""})`)
    .join("; ");
  const held = diagnosis.samePage
    ? `The page at ${diagnosis.url} is alive, but its JavaScript is stopped in the debugger: ${pages}.`
    : `The page at ${diagnosis.url} is alive, but its JavaScript cannot run: another tab of the same browsing group is stopped in the debugger and holds it ("Debugger paused in another tab"): ${pages}.`;
  const holder =
    diagnosis.devtoolsOpen > 0
      ? ` ${diagnosis.devtoolsOpen} DevTools window${diagnosis.devtoolsOpen === 1 ? " is" : "s are"} open in this browser, the usual holder of such a pause.`
      : " No DevTools window is listed, so another debugger client attached to the debug port holds the pause.";

  return `${held}${holder} The expression did not run while the page was stopped; whether it runs once the page resumes is not known, so read the page's state before retrying.`;
}

export const PAUSED_PAGE_HINT =
  "Ask the person to resume it: press Resume (F8) in the DevTools that paused it, or close that DevTools window; a pause held by another debug-port client ends when that client resumes or disconnects. Then retry the same call. This tool does not resume another debugger's pause itself, because that would run past a breakpoint someone set on purpose.";
