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
   diagnosis, an empty log is not.

   The four CLOSE_ codes belong to the same contract and arrive the same way.
   They were carried as literals here while the pinned bridge withheld them,
   because a refusal that names the wrong remedy is worse than a copied number:
   an envelope-version mismatch, a stale instance, an unavailable control
   channel and a dropped slow reader need four different actions from the
   caller, and the close code is the only thing that tells them apart. The pin
   now resolves 4.0.19, whose bridge entry publishes all four, so the copy is
   gone and the numbers move with the engine. */
export {
  CLOSE_BAD_HELLO,
  CLOSE_BAD_INSTANCE,
  CLOSE_CONTROL_UNAVAILABLE,
  CLOSE_SLOW_CONSUMER,
  CONTROL_ENVELOPE_VERSION,
  CONTROL_WS_PATH,
  LOG_EVENT_VERSION,
} from "extension-develop/bridge";

/* @invariant 4000 is not one of the engine's constants and must not become a
   re-export by analogy with the four above. It is RFC 6455's floor for the
   private application range, and what this package does with it is its own
   policy: below the floor the close is the transport's business and gets no
   refusal narrative, at or above it the broker hung up deliberately and the
   caller is told so even when the specific code is one this build has never
   heard of. Importing a floor from the engine would tie that reading rule to
   whatever range the engine happens to use, when the rule is about what a
   consumer may safely assume from a number it does not recognise. */
export const CLOSE_REFUSAL_FLOOR = 4000;

export const DEFAULT_LIMIT = 200;
export const DEFAULT_FOLLOW_MS = 4000;
export const MIN_FOLLOW_MS = 500;
export const MAX_FOLLOW_MS = 15000;
