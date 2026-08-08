// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";
import { mcpOrigins } from "./origins";

export const PLATFORM_HOLD_CODE = "PLATFORM_NOT_OPEN";

export const PLATFORM_HOLD_HEADER = "x-extensiondev-hold";

export const PLATFORM_HOLD_STATUS = "platform-held";

/* @invariant
 * THIS CLIENT HOLDS NO DATE, AND THE BOOLEAN BELOW CANNOT INVENT ONE.
 *
 * extensiondev-readiness records that no announcement date is published and
 * that nothing built from LAUNCH_DATE or LAUNCH_DATE_COPY may be rendered,
 * served or shipped. A published npm tarball is shipped bytes that anyone can
 * unpack, so a date parked here behind a false flag would disclose the day just
 * as loudly as an API body would, and www's own gate already removed it from
 * the refusal for the narrower reason that an agent repeats what it is told.
 *
 * So the flag does not switch a date on, it switches a RELAY on. When it is
 * true this module will quote a day the platform itself put in the refusal
 * body, and when it is false it drops that field on the floor. Today the
 * platform sends no such field, which is why flipping this alone changes
 * nothing visible: it is the client half of a two-sided answer, pre-built so
 * that whichever way Cezar rules the MCP side is this one line and no reader of
 * the tarball can read the date out of it in the meantime.
 */
export const PLATFORM_HOLD_RELAYS_THE_PLATFORM_DATE: boolean = false;

/* @invariant
 * A REFUSAL THAT ONLY REFUSES IS WHAT MAKES SOMEONE CONCLUDE THE PRODUCT IS
 * BROKEN, AND A REFUSAL THAT POINTS AT A HELD SURFACE IS WORSE THAN SILENT.
 *
 * Gabe measured the published client and found the honest half without the
 * useful half: the lanes that carried a refusal at all then sent the reader to
 * console.extension.dev or extension.dev/new, both of which answer 503 while
 * the hold is on. Best case was refuse, then hand somebody an error page.
 *
 * The three parts below are the whole contract. (a) the condition comes from
 * the platform's own sentence where there is one, so the wording is changed in
 * one place and not two. (b) what still works is the part that was missing
 * entirely and is the reason this file exists: creation, development and
 * packaging run on the reader's own machine, they are free forever, and the
 * hold does not touch them, so the true answer to "can I build an extension
 * today" is yes. (c) a way back names templates.extension.dev because it is
 * the one surface the hold leaves open, which makes it the only link a refusal
 * can carry that will not 503, and it needs no date to be useful.
 *
 * ANY URL ADDED HERE MUST BE ONE THE HOLD LEAVES OPEN. That is the whole rule.
 * console, www, code, docs, inspect, preview, themes and userland are held; a
 * link to any of them belongs to the reader's future, not to this refusal.
 */
const HOLD_CONDITION_FALLBACK = "extension.dev is not open to the public yet.";

const HOLD_STILL_WORKS =
  "This does not stop you building. Creating, developing and packaging an extension run on your own machine, they are free forever, and they work right now with no account and no platform: extension_create scaffolds a project, extension_dev runs it in a real browser with live reload, extension_build produces the store-ready package for every browser you target, and extension_manifest_validate with extension_doctor check it before you ship. What is closed is only the part that runs on extension.dev's machines: publishing, promoting a release, submitting to a store, hosting a preview share, and creating a platform project.";

export const PLATFORM_HOLD_STILL_WORKS = [
  "extension_create",
  "extension_dev",
  "extension_build",
  "extension_manifest_validate",
  "extension_doctor",
  "extension_templates",
];

export function templatesOrigin(apiHint?: string): string {
  return mcpOrigins(apiHint).templates.replace(/\/+$/, "");
}

function holdWayBack(apiHint?: string): string {
  return `Templates stay open while the rest is held: browse ${templatesOrigin(
    apiHint,
  )}, or run extension_templates here to list and start from the same set without leaving this session.`;
}

function asRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

export function readPlatformCode(body: unknown): string {
  const record = asRecord(body);
  const code = record?.code;
  return typeof code === "string" ? code.trim() : "";
}

export function readPlatformMessage(body: unknown): string {
  const record = asRecord(body);
  const message = record?.message;
  return typeof message === "string" ? message.trim() : "";
}

/* @invariant
 * THE SIGNAL IS A MACHINE FIELD, NEVER THE SENTENCE.
 *
 * `code` is what the gate promises a client may parse, and the header is what
 * the edge stamps on a held document for the cases where the body is the HTML
 * gate page rather than JSON. Matching the prose instead would tie every reader
 * of this package to a copy edit on www, which is the coupling the prose ban in
 * this repo exists to prevent.
 *
 * The header compare is `=== "held"` and not a presence check because the same
 * header carries "operator-enroll" on the 302 that lets us through the hold. A
 * presence check would read our own way in as a refusal.
 */
export function sawPlatformHold(
  res?: { headers?: { get?: (name: string) => string | null } } | null,
  body?: unknown,
): boolean {
  if (readPlatformCode(body) === PLATFORM_HOLD_CODE) return true;
  try {
    const marker = res?.headers?.get?.(PLATFORM_HOLD_HEADER);
    if (typeof marker === "string" && marker.trim() === "held") return true;
  } catch {
    return false;
  }
  return false;
}

function relayedDate(body: unknown): string {
  if (!PLATFORM_HOLD_RELAYS_THE_PLATFORM_DATE) return "";
  const record = asRecord(body);
  const opensAt = record?.opensAt;
  return typeof opensAt === "string" && opensAt.trim() ? opensAt.trim() : "";
}

export function platformHoldMessage(body?: unknown, apiHint?: string): string {
  const condition = readPlatformMessage(body) || HOLD_CONDITION_FALLBACK;
  const date = relayedDate(body);
  return [
    condition,
    date ? `The platform reports it opens on ${date}.` : "",
    HOLD_STILL_WORKS,
    holdWayBack(apiHint),
  ]
    .filter(Boolean)
    .join(" ");
}

export function platformHoldEnvelope(options: {
  command: string;
  name: string;
  body?: unknown;
  api?: string;
  value?: Record<string, unknown>;
}): string {
  return envelope({
    ok: false,
    command: options.command,
    status: PLATFORM_HOLD_STATUS,
    value: {
      ...(options.value ?? {}),
      stillWorks: PLATFORM_HOLD_STILL_WORKS,
      openSurface: templatesOrigin(options.api),
    },
    error: {
      code: "E_PLATFORM",
      platformCode: PLATFORM_HOLD_CODE,
      name: options.name,
      message: platformHoldMessage(options.body, options.api),
    },
    hint: holdWayBack(options.api),
  });
}
