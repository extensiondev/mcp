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

export const DEFAULT_LIMIT = 200;
export const DEFAULT_FOLLOW_MS = 4000;
export const MIN_FOLLOW_MS = 500;
export const MAX_FOLLOW_MS = 15000;
