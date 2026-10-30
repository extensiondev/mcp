// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { BASELINE_SCRIPT, FRAME_BASELINE_SCRIPT } from "./assert-page-world-reads";

import type { CDPClient } from "../lib/cdp";
import type { Stage } from "./assert";

export type BaselineSource = "same-origin-frame" | "existing-blank" | "created-blank";

export interface Baseline {
  names: string[];
  source: BaselineSource;
  note?: string;
}

const BLANK_FRAME_FLAGS = ["match_about_blank", "match_origin_as_fallback"];

export function blankFrameInjectors(manifest: Record<string, unknown>): string[] {
  const raw = manifest.content_scripts;
  if (!Array.isArray(raw)) return [];

  const out: string[] = [];

  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;

    const block = entry as Record<string, unknown>;
    const flags = BLANK_FRAME_FLAGS.filter((flag) => block[flag] === true);

    if (flags.length > 0) out.push(`content_scripts[${index}] declares ${flags.join(" and ")}`);
  });

  return out;
}

function names(value: unknown): string[] | null {
  return Array.isArray(value) ? value.map(String) : null;
}

async function readFrameBaseline(cdp: CDPClient, sessionId: string): Promise<string[] | null> {
  try {
    return names(await cdp.evaluate(sessionId, FRAME_BASELINE_SCRIPT));
  } catch {
    return null;
  }
}

async function readBlankBaseline(
  stage: Stage,
  cdp: CDPClient,
  targets: Array<{ id: string; type: string; url: string }>,
): Promise<{ names: string[]; source: "existing-blank" | "created-blank" } | null> {
  const spare = targets.find((target) => target.type === "page" && target.url === "about:blank");
  let createdId: string | null = null;

  try {
    let targetId = spare?.id ?? null;

    if (!targetId) {
      const created = (await cdp.sendCommand("Target.createTarget", { url: "about:blank", background: true })) as
        | { targetId?: string }
        | undefined;
      if (typeof created?.targetId !== "string") return null;

      createdId = created.targetId;
      targetId = createdId;
    }

    const attached = await stage.attach(targetId);
    if (!attached) return null;

    const read = names(await attached.cdp.evaluate(attached.sessionId, BASELINE_SCRIPT));
    if (!read) return null;

    return { names: read, source: createdId ? "created-blank" : "existing-blank" };
  } catch {
    return null;
  } finally {
    if (createdId) await cdp.sendCommand("Target.closeTarget", { targetId: createdId }).catch(() => undefined);
  }
}

export async function readBaseline(
  stage: Stage,
  page: { cdp: CDPClient; sessionId: string },
  targets: Array<{ id: string; type: string; url: string }>,
  manifest: Record<string, unknown>,
): Promise<Baseline | null> {
  const injectors = blankFrameInjectors(manifest);
  let note: string;

  if (injectors.length === 0) {
    const frame = await readFrameBaseline(page.cdp, page.sessionId);
    if (frame) return { names: frame, source: "same-origin-frame" };

    note = "the page did not answer the same-origin frame read";
  } else {
    note = `${injectors.join(", ")}, so a frame inside the page could carry the extension's own scripts`;
  }

  const blank = await readBlankBaseline(stage, page.cdp, targets);
  if (!blank) return null;

  return {
    ...blank,
    note: `The baseline was read off a background about:blank tab, not a frame inside the page, because ${note}; an about:blank tab is not a secure context, so secure-context-only browser globals may show as unknown.`,
  };
}
