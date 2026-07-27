// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant The one shape every tool returns. It is duplicated from the CLI's
   schema-1 envelope on purpose: src/__tests__/contract/ holds the bytes that
   keep the two copies honest, so neither repo gains a dependency on the other. */

export const ENVELOPE_SCHEMA = 1 as const;

export const DECISION_D6 =
  "The MCP tool name owns the envelope `command` key; forking the key to `tool` would fork the schema the checksum test pins.";

export type ErrorCode =
  | "E_AMBIGUOUS_TARGET"
  | "E_AUTH_DENIED"
  | "E_AUTH_EXPIRED"
  | "E_AUTH_FAILED"
  | "E_AUTH_PENDING"
  | "E_AUTH_REQUIRED"
  | "E_BAD_HOST_URL"
  | "E_BAD_MANIFEST"
  | "E_BAD_REQUEST"
  | "E_BRIDGE"
  | "E_BROWSER_EXITED"
  | "E_BROWSER_INSTALL"
  | "E_BROWSER_UNINSTALL"
  | "E_BUILD_FAILED"
  | "E_CARRIER_IN_DIST"
  | "E_CDP"
  | "E_CLI"
  | "E_COMPILE"
  | "E_CONFIG"
  | "E_CONTRACT_ERROR"
  | "E_CONTROL_CHANNEL"
  | "E_ENTRYPOINT_MISSING"
  | "E_FIRST_COMPILE"
  | "E_INPUT_VALIDATION"
  | "E_INTERNAL"
  | "E_LOGS_MISSING"
  | "E_MANIFEST_BLOCKING"
  | "E_MANIFEST_NOT_FOUND"
  | "E_NAVIGATE_ERROR"
  | "E_NAVIGATE_FAILED"
  | "E_NETWORK"
  | "E_NO_CONTROL_CHANNEL"
  | "E_NO_DIST"
  | "E_NO_EXTENSION_ID"
  | "E_NO_MATCHING_TARGET"
  | "E_NO_REFERENCE_TEMPLATE"
  | "E_NO_SESSION"
  | "E_NO_SURFACE_DOCUMENT"
  | "E_NO_TARGET"
  | "E_NOT_ATTACHED"
  | "E_PARSE"
  | "E_PLATFORM"
  | "E_PREVIEW_HOST_UNREACHABLE"
  | "E_PROFILE_LOCKED"
  | "E_RDP"
  | "E_SCAFFOLD_FAILED"
  | "E_SCAFFOLD_INCOMPLETE"
  | "E_SESSION_EXISTS"
  | "E_SESSION_EXITED"
  | "E_STALE_CONTRACT"
  | "E_SURFACE_DID_NOT_OPEN"
  | "E_TEMPLATE_FETCH"
  | "E_TEMPLATE_NOT_FOUND"
  | "E_UNKNOWN_COMMAND"
  | "E_UNKNOWN_TOOL"
  | "E_UNSUPPORTED_BROWSER"
  | "E_WAIT_TIMEOUT";

export const ERROR_CODES: ErrorCode[] = [
  "E_AMBIGUOUS_TARGET",
  "E_AUTH_DENIED",
  "E_AUTH_EXPIRED",
  "E_AUTH_FAILED",
  "E_AUTH_PENDING",
  "E_AUTH_REQUIRED",
  "E_BAD_HOST_URL",
  "E_BAD_MANIFEST",
  "E_BAD_REQUEST",
  "E_BRIDGE",
  "E_BROWSER_EXITED",
  "E_BROWSER_INSTALL",
  "E_BROWSER_UNINSTALL",
  "E_BUILD_FAILED",
  "E_CARRIER_IN_DIST",
  "E_CDP",
  "E_CLI",
  "E_COMPILE",
  "E_CONFIG",
  "E_CONTRACT_ERROR",
  "E_CONTROL_CHANNEL",
  "E_ENTRYPOINT_MISSING",
  "E_FIRST_COMPILE",
  "E_INPUT_VALIDATION",
  "E_INTERNAL",
  "E_LOGS_MISSING",
  "E_MANIFEST_BLOCKING",
  "E_MANIFEST_NOT_FOUND",
  "E_NAVIGATE_ERROR",
  "E_NAVIGATE_FAILED",
  "E_NETWORK",
  "E_NO_CONTROL_CHANNEL",
  "E_NO_DIST",
  "E_NO_EXTENSION_ID",
  "E_NO_MATCHING_TARGET",
  "E_NO_REFERENCE_TEMPLATE",
  "E_NO_SESSION",
  "E_NO_SURFACE_DOCUMENT",
  "E_NO_TARGET",
  "E_NOT_ATTACHED",
  "E_PARSE",
  "E_PLATFORM",
  "E_PREVIEW_HOST_UNREACHABLE",
  "E_PROFILE_LOCKED",
  "E_RDP",
  "E_SCAFFOLD_FAILED",
  "E_SCAFFOLD_INCOMPLETE",
  "E_SESSION_EXISTS",
  "E_SESSION_EXITED",
  "E_STALE_CONTRACT",
  "E_SURFACE_DID_NOT_OPEN",
  "E_TEMPLATE_FETCH",
  "E_TEMPLATE_NOT_FOUND",
  "E_UNKNOWN_COMMAND",
  "E_UNKNOWN_TOOL",
  "E_UNSUPPORTED_BROWSER",
  "E_WAIT_TIMEOUT",
];

export interface EnvelopeError {
  code: ErrorCode | string;
  message: string;
  name?: string;
  engine?: string | null;
  hint?: string;
  [key: string]: unknown;
}

export interface Envelope {
  schema: typeof ENVELOPE_SCHEMA;
  ok: boolean;
  command: string;
  status: string;
  value: unknown;
  error: EnvelopeError | null;
  truncated?: boolean;
  hint?: string;
  warnings: string[];
}

export interface EnvelopeInit {
  ok: boolean;
  command: string;
  status: string;
  value?: unknown;
  error?: EnvelopeError | null;
  truncated?: boolean;
  hint?: string;
  warnings?: (string | null | undefined | false)[];
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

export function envelopeObject(init: EnvelopeInit): Envelope {
  const frame: Envelope = {
    schema: ENVELOPE_SCHEMA,
    ok: init.ok,
    command: init.command,
    status: init.status,
    value: init.value === undefined ? null : init.value,
    error: init.error ?? null,
    warnings: collectWarnings(init.warnings),
  };
  if (init.truncated !== undefined) frame.truncated = init.truncated;
  if (typeof init.hint === "string" && init.hint) frame.hint = init.hint;
  return frame;
}

export function envelope(init: EnvelopeInit): string {
  return JSON.stringify(envelopeObject(init));
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
