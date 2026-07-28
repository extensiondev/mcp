// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant The control-channel wire constants come from the engine, not from
   literals typed here. They are not layout, they are protocol: the running dev
   server's broker compares the hello frame's `v` against ITS OWN
   CONTROL_ENVELOPE_VERSION and closes the socket with 4002 "unsupported
   envelope version" on any mismatch, and its WebSocketServer is bound to a
   single path so a wrong CONTROL_WS_PATH is refused at the HTTP upgrade.

   That makes version skew load-bearing here in a way it is not for file paths.
   This package pins one engine version; the project it drives may have an older
   one installed. A literal "1" typed here is frozen at whatever the protocol was
   when someone typed it and drifts silently; importing the engine's constant at
   least means the value moves with a reviewable version bump and always matches
   the engine this package is tested against. Neither choice can make the MCP
   speak two protocol versions at once. What closes the gap is legibility, so
   readFromStream reports the close code and reason verbatim instead of
   returning an empty read: a 4xxx close naming the envelope version is a
   diagnosis, an empty log is not. */
export {
  CONTROL_ENVELOPE_VERSION,
  CONTROL_WS_PATH,
  LOG_EVENT_VERSION,
} from "extension-develop/bridge";

/* @invariant The broker's refusal codes, copied rather than imported, and the
   copy is the smaller of two wrongs only for as long as the pin says so.

   The engine publishes these on `extension-develop/bridge` as CLOSE_BAD_INSTANCE,
   CLOSE_BAD_HELLO, CLOSE_CONTROL_UNAVAILABLE and CLOSE_SLOW_CONSUMER, but that
   export landed AFTER the release this package pins: the bridge entry of
   extension-develop 4.0.19-canary.1785200797.ce99a79e re-exports
   CONTROL_ENVELOPE_VERSION, CONTROL_WS_PATH and LOG_EVENT_VERSION and nothing
   else, and the package's `exports` map has no deep path that would reach
   dev-server/control-bridge/contracts. So an import of these names does not
   typecheck and evaluates to undefined at runtime against the engine actually
   installed here, which would make every refusal compare equal to undefined and
   read as an unrecognised close.

   The values below were read off the engine's own
   programs/develop/dev-server/control-bridge/contracts.ts, not inferred from
   behaviour, and engine-skew asserts that the pinned bridge still does NOT
   publish them. That assertion fails the day the pin moves past the publishing
   release, which is the day this block must become a re-export next to the
   three constants above. Until then a refusal that names the wrong remedy is a
   worse failure than a copied number: an envelope-version mismatch, an
   unavailable control channel and a dropped slow reader need three different
   actions from the caller, and the code is the only thing that tells them
   apart. */
export const CLOSE_REFUSAL_FLOOR = 4000;
export const CLOSE_BAD_INSTANCE = 4001;
export const CLOSE_BAD_HELLO = 4002;
export const CLOSE_CONTROL_UNAVAILABLE = 4003;
export const CLOSE_SLOW_CONSUMER = 4008;

export const DEFAULT_LIMIT = 200;
export const DEFAULT_FOLLOW_MS = 4000;
export const MIN_FOLLOW_MS = 500;
export const MAX_FOLLOW_MS = 15000;
