// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { meterComposedDashboardUrls } from "./dashboard-url-meter";
import { takeDeferredWarnings } from "./deferred-warnings";
import { deadEngineOverrideLine } from "./engine-override-warning";
import { withRefusalHint } from "./refusal-hints";
import { withRetry, type RetryVerdict } from "./retry";

export type { RetryVerdict } from "./retry";

export const ENVELOPE_SCHEMA = 1 as const;


export type ErrorCode =
  | "E_ACTION_NOT_REPLAYED"
  | "E_AMBIGUOUS_TARGET"
  | "E_APPROVAL_PENDING"
  | "E_APPROVAL_REJECTED"
  | "E_APPROVAL_REQUIRED"
  | "E_ARTIFACTS_UNVERIFIED"
  | "E_AUTH_DENIED"
  | "E_AUTH_EXPIRED"
  | "E_AUTH_FAILED"
  | "E_AUTH_REQUIRED"
  | "E_BAD_HOST_URL"
  | "E_BAD_MANIFEST"
  | "E_BAD_REQUEST"
  | "E_BRIDGE"
  | "E_BROWSER_EXITED"
  | "E_BROWSER_INSTALL"
  | "E_BROWSER_UNINSTALL"
  | "E_BUILD_FAILED"
  | "E_BUILD_NOT_FOUND"
  | "E_BUILD_TIMEOUT"
  | "E_CARRIER_IN_DIST"
  | "E_CDP"
  | "E_CLI"
  | "E_COMPILE"
  | "E_CONFIG"
  | "E_CONSOLE_ONLY"
  | "E_CONTENT_WORLD_ORPHANED"
  | "E_ELEMENT_AMBIGUOUS"
  | "E_ELEMENT_NOT_EDITABLE"
  | "E_ELEMENT_NOT_FOUND"
  | "E_ELEMENT_NOT_VISIBLE"
  | "E_CONTRACT_ERROR"
  | "E_CONTROL_CHANNEL"
  | "E_CONTROL_ENVELOPE"
  | "E_CREATE_STUCK"
  | "E_DEV_SESSION_DIST_SHARED"
  | "E_ENGINE_TOO_OLD"
  | "E_ENTRYPOINT_MISSING"
  | "E_FIRST_COMPILE"
  | "E_INPUT_VALIDATION"
  | "E_INTERNAL"
  | "E_INVALID_BUNDLE_ID"
  | "E_LOGS_MISSING"
  | "E_MANIFEST_BLOCKING"
  | "E_MANIFEST_NOT_FOUND"
  | "E_NAVIGATE_ERROR"
  | "E_NAVIGATE_FAILED"
  | "E_NETWORK"
  | "E_NO_CONTROL_CHANNEL"
  | "E_NO_BACKGROUND"
  | "E_NO_CONTEXT_MENUS"
  | "E_NO_LISTENER"
  | "E_NO_DIST"
  | "E_NO_THEME"
  | "E_NO_EXTENSION_ID"
  | "E_NO_MATCHING_TARGET"
  | "E_NO_REFERENCE_TEMPLATE"
  | "E_NO_SESSION"
  | "E_NO_SURFACE_DOCUMENT"
  | "E_NO_LOGIN_FOR_PROJECT"
  | "E_NO_TARGET"
  | "E_NOT_ATTACHED"
  | "E_PAGE_NOT_SCRIPTABLE"
  | "E_PAGE_PAUSED"
  | "E_PARSE"
  | "E_PLATFORM"
  | "E_PREVIEW_HOST_UNREACHABLE"
  | "E_PROFILE_LOCKED"
  | "E_PROJECT_AMBIGUOUS"
  | "E_RDP"
  | "E_SAFARI_CONTEXT_UNREACHABLE"
  | "E_SAFARI_APP_BUILDING"
  | "E_SAFARI_ONLY_OPTION"
  | "E_EVAL"
  | "E_EVAL_DISABLED"
  | "E_EVAL_NOT_CLONEABLE"
  | "E_SCAFFOLD_FAILED"
  | "E_SCAFFOLD_INCOMPLETE"
  | "E_SERVER_STALE"
  | "E_SESSION_AMBIGUOUS"
  | "E_EXTENSION_PAGE_UNREACHABLE"
  | "E_EXTENSION_RELOADING"
  | "E_SESSION_EXISTS"
  | "E_SESSION_EXITED"
  | "E_STALE_CONTRACT"
  | "E_SURFACE_DID_NOT_OPEN"
  | "E_TAB_NOT_FOUND"
  | "E_TARGET_NOT_FOUND"
  | "E_TEAM_UNKNOWN_TO_XCODE"
  | "E_TEMPLATE_FETCH"
  | "E_TEMPLATE_NOT_FOUND"
  | "E_TOOL_DISABLED"
  | "E_UNKNOWN_COMMAND"
  | "E_UNKNOWN_TOOL"
  | "E_UNSUPPORTED_BROWSER"
  | "E_WAIT_TIMEOUT"
  | "E_WEBDRIVER_SESSION_ENDED"
  | "E_ASSERT_FAILED"
  | "E_CAPTURE_FAILED"
  | "E_CAPTURE_TIMEOUT"
  | "E_COMMAND_UNSUPPORTED_FOR_TARGET"
  | "E_CONTROL_DENIED"
  | "E_CONTROL_UNAVAILABLE"
  | "E_CSP_BLOCKS_EVAL"
  | "E_NOT_IMPLEMENTED"
  | "E_PREFLIGHT_FAILED"
  | "E_SESSION_NOT_FOUND"
  | "E_STATUS_UNAVAILABLE"
  | "E_STOP_INCOMPLETE"
  | "E_SURFACE_NOT_CAPTURABLE"
  | "E_UNHEALTHY"
  | "E_UNSPECIFIED"
  | "E_USER_GESTURE_REQUIRED";

export const ERROR_CODES: ErrorCode[] = [
  "E_ACTION_NOT_REPLAYED",
  "E_AMBIGUOUS_TARGET",
  "E_APPROVAL_PENDING",
  "E_APPROVAL_REJECTED",
  "E_APPROVAL_REQUIRED",
  "E_ARTIFACTS_UNVERIFIED",
  "E_AUTH_DENIED",
  "E_AUTH_EXPIRED",
  "E_AUTH_FAILED",
  "E_AUTH_REQUIRED",
  "E_BAD_HOST_URL",
  "E_BAD_MANIFEST",
  "E_BAD_REQUEST",
  "E_BRIDGE",
  "E_BROWSER_EXITED",
  "E_BROWSER_INSTALL",
  "E_BROWSER_UNINSTALL",
  "E_BUILD_FAILED",
  "E_BUILD_NOT_FOUND",
  "E_BUILD_TIMEOUT",
  "E_CARRIER_IN_DIST",
  "E_CDP",
  "E_CLI",
  "E_COMPILE",
  "E_CONFIG",
  "E_CONSOLE_ONLY",
  "E_CONTENT_WORLD_ORPHANED",
  "E_ELEMENT_AMBIGUOUS",
  "E_ELEMENT_NOT_EDITABLE",
  "E_ELEMENT_NOT_FOUND",
  "E_ELEMENT_NOT_VISIBLE",
  "E_CONTRACT_ERROR",
  "E_CONTROL_CHANNEL",
  "E_CONTROL_ENVELOPE",
  "E_CREATE_STUCK",
  "E_DEV_SESSION_DIST_SHARED",
  "E_ENGINE_TOO_OLD",
  "E_ENTRYPOINT_MISSING",
  "E_FIRST_COMPILE",
  "E_INPUT_VALIDATION",
  "E_INTERNAL",
  "E_INVALID_BUNDLE_ID",
  "E_LOGS_MISSING",
  "E_MANIFEST_BLOCKING",
  "E_MANIFEST_NOT_FOUND",
  "E_NAVIGATE_ERROR",
  "E_NAVIGATE_FAILED",
  "E_NETWORK",
  "E_NO_CONTROL_CHANNEL",
  "E_NO_BACKGROUND",
  "E_NO_CONTEXT_MENUS",
  "E_NO_LISTENER",
  "E_NO_DIST",
  "E_NO_THEME",
  "E_NO_EXTENSION_ID",
  "E_NO_MATCHING_TARGET",
  "E_NO_REFERENCE_TEMPLATE",
  "E_NO_SESSION",
  "E_NO_SURFACE_DOCUMENT",
  "E_NO_LOGIN_FOR_PROJECT",
  "E_NO_TARGET",
  "E_NOT_ATTACHED",
  "E_PAGE_NOT_SCRIPTABLE",
  "E_PAGE_PAUSED",
  "E_PARSE",
  "E_PLATFORM",
  "E_PREVIEW_HOST_UNREACHABLE",
  "E_PROFILE_LOCKED",
  "E_PROJECT_AMBIGUOUS",
  "E_RDP",
  "E_SAFARI_CONTEXT_UNREACHABLE",
  "E_SAFARI_APP_BUILDING",
  "E_SAFARI_ONLY_OPTION",
  "E_EVAL",
  "E_EVAL_DISABLED",
  "E_EVAL_NOT_CLONEABLE",
  "E_SCAFFOLD_FAILED",
  "E_SCAFFOLD_INCOMPLETE",
  "E_SERVER_STALE",
  "E_SESSION_AMBIGUOUS",
  "E_EXTENSION_PAGE_UNREACHABLE",
  "E_EXTENSION_RELOADING",
  "E_SESSION_EXISTS",
  "E_SESSION_EXITED",
  "E_STALE_CONTRACT",
  "E_SURFACE_DID_NOT_OPEN",
  "E_TAB_NOT_FOUND",
  "E_TARGET_NOT_FOUND",
  "E_TEAM_UNKNOWN_TO_XCODE",
  "E_TEMPLATE_FETCH",
  "E_TEMPLATE_NOT_FOUND",
  "E_TOOL_DISABLED",
  "E_UNKNOWN_COMMAND",
  "E_UNKNOWN_TOOL",
  "E_UNSUPPORTED_BROWSER",
  "E_WAIT_TIMEOUT",
  "E_WEBDRIVER_SESSION_ENDED",
  "E_ASSERT_FAILED",
  "E_CAPTURE_FAILED",
  "E_CAPTURE_TIMEOUT",
  "E_COMMAND_UNSUPPORTED_FOR_TARGET",
  "E_CONTROL_DENIED",
  "E_CONTROL_UNAVAILABLE",
  "E_CSP_BLOCKS_EVAL",
  "E_NOT_IMPLEMENTED",
  "E_PREFLIGHT_FAILED",
  "E_SESSION_NOT_FOUND",
  "E_STATUS_UNAVAILABLE",
  "E_STOP_INCOMPLETE",
  "E_SURFACE_NOT_CAPTURABLE",
  "E_UNHEALTHY",
  "E_UNSPECIFIED",
  "E_USER_GESTURE_REQUIRED",
];

export interface EnvelopeError {
  code: ErrorCode | string;
  message: string;
  name?: string;
  engine?: string | null;
  hint?: string;
  retry?: RetryVerdict;
  [key: string]: unknown;
}

export interface EnvelopeFailure extends EnvelopeError {
  hint: string;
  retry: RetryVerdict;
}

export interface Envelope {
  schema: typeof ENVELOPE_SCHEMA;
  ok: boolean;
  command: string;
  status: string;
  value: unknown;
  error: EnvelopeFailure | null;
  truncated?: boolean;
  hint?: string;
  warnings: string[];
}

interface EnvelopeFields {
  command: string;
  status: string;
  value?: unknown;
  truncated?: boolean;
  hint?: string;
  warnings?: Array<string | null | undefined | false>;
}

/* @invariant A FAILURE CANNOT BE BUILT WITHOUT AN ERROR, AND NO FAILURE
 * LEAVES WITHOUT error.hint. The init type is a union on `ok`: `ok: false`
 * takes an error with a code and a message, so a refusal written with none
 * does not compile, and a call whose `ok` is computed has to say which side
 * it is on. envelopeObject then fills error.hint from the site's own hint,
 * the frame's hint or the code's line in refusal-hints.ts, in that order,
 * the way it fills error.retry. Before ledger 912 extension_stop answered
 * `ok: false, error: null` for a project with no session and
 * extension_doctor did for a failing check. A frame rebuilt from parsed
 * JSON (reframed below) is not typed on `ok`, so a failure that reaches it
 * with no error leaves as E_UNSPECIFIED instead of as null.
 */
export type EnvelopeInit = EnvelopeFields & (
  | { ok: true; error?: null }
  | { ok: false; error: EnvelopeError }
);

export function okOrRefusal(ok: boolean, refusal: () => EnvelopeError): { ok: true } | { ok: false; error: EnvelopeError } {
  return ok ? { ok: true } : { ok: false, error: refusal() };
}

export interface ParsedFrame extends EnvelopeFields {
  ok: boolean;
  error?: EnvelopeError | null;
}

const collectWarnings = (
  warnings: EnvelopeInit["warnings"],
): string[] => {
  if (!warnings) return [];

  const kept: string[] = [];

  for (const warning of warnings) {
    if (typeof warning !== "string") continue;

    const text = warning.trim();
    if (text && !kept.includes(text)) kept.push(text);
  }

  return kept;
};

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b);

const TERMINAL_ESCAPE = new RegExp(
  [
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    `(?:${ESC}\\[|${CSI})[0-?]*[ -/]*[@-~]`,
    `${ESC}[()#][0-9A-Za-z]`,
    `${ESC}[@-Z\\\\-_]`,
  ].join("|"),
  "g",
);

function stripTerminalEscapes(text: string): string {
  return text.includes(ESC) || text.includes(CSI)
    ? text.replace(TERMINAL_ESCAPE, "")
    : text;
}

function plainText<T>(field: T): T {
  if (typeof field === "string") return stripTerminalEscapes(field) as T;
  if (Array.isArray(field)) return field.map(plainText) as T;
  if (!field || typeof field !== "object") return field;

  const proto: unknown = Object.getPrototypeOf(field);
  if (proto !== Object.prototype && proto !== null) return field;

  const plain: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(field)) plain[key] = plainText(entry);

  return plain as T;
}

function failureOf(init: ParsedFrame): EnvelopeFailure | null {
  const error = init.error ?? (init.ok ? null : { code: "E_UNSPECIFIED", message: `${init.command} answered ${init.status} and named no error.` });

  if (!error) return null;

  const judged = withRetry(error, init.command, init.value);

  return plainText(init.ok ? (judged as EnvelopeFailure) : withRefusalHint(judged, init.command, init.hint));
}

export function reframedObject(init: ParsedFrame): Envelope {
  const frame: Envelope = {
    schema: ENVELOPE_SCHEMA,
    ok: init.ok,
    command: init.command,
    status: init.status,
    value: init.value === undefined ? null : plainText(init.value),
    error: failureOf(init),
    warnings: collectWarnings([...(init.warnings ?? []), ...takeDeferredWarnings(), deadEngineOverrideLine()].map(plainText)),
  };
  if (init.truncated !== undefined) frame.truncated = init.truncated;
  if (typeof init.hint === "string" && init.hint) frame.hint = stripTerminalEscapes(init.hint);

  void meterComposedDashboardUrls(frame);

  return frame;
}

export function envelopeObject(init: EnvelopeInit): Envelope {
  return reframedObject(init);
}

export function envelope(init: EnvelopeInit): string {
  return JSON.stringify(reframedObject(init));
}

export function reframed(parsed: ParsedFrame): string {
  return JSON.stringify(reframedObject(parsed));
}

export function hintedAnswer(text: string): string {
  if (!text.includes('"ok":false')) return text;

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }

  if (!isEnvelope(parsed) || parsed.ok !== false) return text;
  if (parsed.error && typeof parsed.error.hint === "string" && parsed.error.hint.trim()) return text;

  const error = parsed.error ?? { code: "E_UNSPECIFIED", message: `${parsed.command} answered ${parsed.status} and named no error.` };

  return JSON.stringify({ ...parsed, error: withRefusalHint(withRetry(error, parsed.command, parsed.value), parsed.command, parsed.hint) });
}

export function sessionCommandSinceEnvelopeOwnsCommand(contract: {
  command?: string;
}): { sessionCommand?: string } {
  return contract.command === undefined
    ? {}
    : { sessionCommand: contract.command };
}

export function isEnvelope(frame: unknown): frame is Envelope {
  return (
    !!frame &&
    typeof frame === "object" &&
    (frame as Envelope).schema === ENVELOPE_SCHEMA
  );
}
