// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { handler as openSurface } from "../tools/open";
import { actFrameJson, addWarning, patchValue } from "./act";
import { WEBKIT_FAMILY } from "./browser-family";
import { envelope } from "./envelope";
import { parseFrameObject } from "./frame-json";
import { resolveSessionBrowser } from "./session-browser";

export const OPENABLE_SURFACES: readonly string[] = ["popup", "options", "sidebar", "newtab", "history", "bookmarks"];

export interface OpenRequest {
  command: string;
  projectPath: string;
  browser: string;
  surface: string;
  timeout?: number;
  asTab?: boolean;
}

export type SurfaceOpen = { opened: boolean; answer: Record<string, any> };

interface ReaderArgs {
  projectPath: string;
  browser?: string;
  context?: string;
  targetId?: string;
  timeout?: number;
}

export function surfaceOpening(
  command: string,
  args: ReaderArgs,
  asTab: (surface: string, browser: string) => boolean = () => false,
): OpenRequest | null {
  const surface = args.context;
  if (!surface || !OPENABLE_SURFACES.includes(surface) || args.targetId) return null;

  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  if (WEBKIT_FAMILY.has(browser)) return null;

  return {
    command,
    projectPath: args.projectPath,
    browser,
    surface,
    timeout: args.timeout,
    ...(asTab(surface, browser) ? { asTab: true } : {}),
  };
}

export function surfaceClosed(frame: Record<string, any> | null): boolean {
  if (!frame || frame.ok !== false) return false;

  const code = String(frame.error?.code ?? "");
  if (frame.status === "no-target" || code === "E_NO_TARGET" || code === "E_TARGET_NOT_FOUND") return true;

  return /\bis not open\b/i.test(String(frame.error?.message ?? ""));
}

export function openCall(request: Pick<OpenRequest, "surface" | "asTab">): string {
  return `extension_open surface: "${request.surface}"${request.asTab ? ", asTab: true" : ""}`;
}

export async function openClosedSurface(request: OpenRequest): Promise<SurfaceOpen> {
  const raw = await openSurface({
    projectPath: request.projectPath,
    browser: request.browser,
    surface: request.surface,
    timeout: request.timeout,
    ...(request.asTab ? { asTab: true } : {}),
  });
  const answer = parseFrameObject(raw) ?? {
    ok: false,
    status: "open-unreadable",
    error: {
      code: "E_SURFACE_DID_NOT_OPEN",
      name: "SurfaceDidNotOpen",
      message: `extension_open answered something this server could not read: ${raw.slice(0, 200)}`,
    },
  };

  return { opened: answer.ok === true, answer };
}

export function openFailedSentence(answer: Record<string, any>): string {
  return `extension_open answered ${String(answer.status ?? "nothing")}: ${String(answer.error?.message ?? "no reason was given")}`;
}

function openFailedRefusal(request: OpenRequest, read: Record<string, any> | null, answer: Record<string, any>): string {
  const readValue = read?.value && typeof read.value === "object" && !Array.isArray(read.value) ? read.value : {};
  const readWords = typeof read?.error?.message === "string" ? ` (${read.error.message})` : "";

  return envelope({
    ok: false,
    command: request.command,
    status: typeof answer.status === "string" ? answer.status : "surface-did-not-open",
    error: {
      code: typeof answer.error?.code === "string" ? answer.error.code : "E_SURFACE_DID_NOT_OPEN",
      name: typeof answer.error?.name === "string" ? answer.error.name : "SurfaceDidNotOpen",
      message: `The ${request.surface} was not open${readWords}, and opening it the way ${openCall(request)} does did not land it: ${String(answer.error?.message ?? "no reason was given")}`,
      ...(typeof answer.error?.engine === "string" ? { engine: answer.error.engine } : {}),
    },
    value: {
      ...readValue,
      surface: request.surface,
      opened: false,
      ...(answer.value !== undefined && answer.value !== null ? { openAnswer: answer.value } : {}),
    },
    ...(typeof answer.hint === "string" ? { hint: answer.hint } : {}),
    warnings: Array.isArray(answer.warnings) ? answer.warnings : [],
  });
}

function stillClosedHint(request: OpenRequest, answer: Record<string, any>): string {
  return `This call opened the ${request.surface} (extension_open answered ${String(answer.status ?? "ok")}) and the read that followed still found it closed; a popup window closes when focus leaves it. Open it as a tab with extension_open surface: "${request.surface}", asTab: true and pass the targetId it answers.`;
}

export async function readOpeningIfClosed(read: () => Promise<string>, request: OpenRequest | null): Promise<string> {
  const first = await read();
  if (!request) return first;

  const refused = parseFrameObject(first);
  if (!surfaceClosed(refused)) return first;

  const open = await openClosedSurface(request);
  if (!open.opened) return openFailedRefusal(request, refused, open.answer);

  const second = await read();
  const frame = parseFrameObject(second);
  if (!frame) return second;

  const wrapped = frame.value !== null && frame.value !== undefined && (typeof frame.value !== "object" || Array.isArray(frame.value));
  patchValue(frame, { opened: true });

  for (const warning of Array.isArray(open.answer.warnings) ? open.answer.warnings : []) addWarning(frame, warning);

  addWarning(
    frame,
    `The ${request.surface} was closed, so this call opened it the way ${openCall(request)} does, then read it; value.opened says so${wrapped ? " and value.result holds what the read answered" : ""}.`,
  );

  if (surfaceClosed(frame)) frame.hint = stillClosedHint(request, open.answer);

  return actFrameJson(frame);
}
