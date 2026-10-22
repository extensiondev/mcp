// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type { CDPClient } from "./cdp";

export const TAB_VIEW_SCRIPT =
  "({ visibilityState: document.visibilityState, width: window.innerWidth, height: window.innerHeight })";

export interface TabViewFields {
  tab?: { active: boolean; visibilityState?: string };
  viewport?: { width: number; height: number };
}

function sized(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function tabViewFields(raw: unknown): TabViewFields {
  if (!raw || typeof raw !== "object") return {};

  const read = raw as Record<string, unknown>;
  const visibilityState =
    typeof read.visibilityState === "string" ? read.visibilityState : undefined;
  const active =
    typeof read.active === "boolean"
      ? read.active
      : visibilityState !== undefined
        ? visibilityState === "visible"
        : undefined;
  const fields: TabViewFields = {};

  if (active !== undefined) {
    fields.tab = { active, ...(visibilityState !== undefined ? { visibilityState } : {}) };
  }

  if (sized(read.width) && sized(read.height)) {
    fields.viewport = { width: read.width, height: read.height };
  }

  return fields;
}

export async function readTabView(
  cdp: Pick<CDPClient, "attachToTarget" | "evaluate">,
  targetId: string,
): Promise<TabViewFields> {
  try {
    const sessionId = await cdp.attachToTarget(targetId);

    return tabViewFields(await cdp.evaluate(sessionId, TAB_VIEW_SCRIPT));
  } catch {
    return {};
  }
}

export function tabViewSentence(fields: TabViewFields): string | null {
  const parts: string[] = [];

  if (fields.tab) {
    parts.push(
      fields.tab.active
        ? "The tab is the one its window shows."
        : `The tab is hidden (${fields.tab.visibilityState ?? "not the active tab"}), so IntersectionObserver callbacks, requestAnimationFrame and timers wait until it is shown; extension_eval still runs in it.`,
    );
  }

  if (fields.viewport) {
    parts.push(
      `The viewport is ${fields.viewport.width}x${fields.viewport.height}: an element below it is not observed (IntersectionObserver, lazy loading) until it is scrolled into view, with extension_eval element.scrollIntoView() or window.scrollTo.`,
    );
  }

  return parts.length > 0 ? parts.join(" ") : null;
}
