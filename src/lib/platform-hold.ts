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

export const PLATFORM_HOLD_RELAYS_THE_PLATFORM_DATE = false;

const HOLD_CONDITION_FALLBACK = "extension.dev is not open to the public yet.";

const HOLD_STILL_WORKS =
  "This does not stop you building. Creating, developing and packaging an extension run on your own machine, need no account and nothing from the platform, and work right now: extension_create scaffolds a project, extension_dev runs it in a real browser with live reload, extension_build produces the store-ready package for every browser you target, and extension_manifest_validate with extension_doctor check it before you ship. What is closed is the part that runs on extension.dev's machines: publishing, promoting a release, submitting to a store, hosting a preview share, requesting an approval, and creating a platform project or workspace.";

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

export function sawPlatformHold(
  res?: { headers?: { get?: (name: string) => string | null } } | null,
  body?: unknown,
): boolean {
  if (readPlatformCode(body) === PLATFORM_HOLD_CODE) return true;

  const marker = res?.headers?.get?.(PLATFORM_HOLD_HEADER);

  return typeof marker === "string" && marker.trim() === "held";
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
