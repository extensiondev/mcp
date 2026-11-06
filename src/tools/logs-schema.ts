// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { SESSION_PROJECT_PATH } from "../lib/common-schema";
import {
  DEFAULT_LIMIT,
  DEFAULT_FOLLOW_MS,
  MIN_FOLLOW_MS,
  MAX_FOLLOW_MS,
} from "./logs-constants";

export const schema = {
  name: "extension_logs",
  description:
    "Read a dev session's logs from every context in one timeline, or follow:true for live frames after the replayed ring. Works on a `npx extension dev` run by hand (follow needs --allow-control there); not on extension_start.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      browser: {
        type: "string",
        description:
          "Session browser; default the live session, else chrome.",
      },
      level: {
        type: "string",
        enum: ["off", "error", "warn", "info", "debug", "trace", "all"],
        default: "all",
        description:
          "Minimum severity.",
      },
      context: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "background",
            "content",
            "sidebar",
            "popup",
            "options",
            "devtools",
            "newtab",
            "history",
            "bookmarks",
          ],
        },
        description: "Only these contexts.",
      },
      signalsOnly: {
        type: "boolean",
        default: false,
        description:
          "Only dx.signal diagnostics.",
      },
      since: {
        type: "number",
        description:
          "Only events after this seq (the polling cursor).",
      },
      url: {
        type: "string",
        description:
          "Only events whose url matches (glob or substring).",
      },
      tab: {
        type: "number",
        description: "Only this tab id.",
      },
      match: {
        type: "string",
        description: "Only lines matching this regex or substring.",
      },
      follow: {
        type: "boolean",
        default: false,
        description:
          "Collect live frames.",
      },
      followMs: {
        type: "number",
        default: DEFAULT_FOLLOW_MS,
        description: "ms to collect live frames (500 to 15000).",
      },
      limit: {
        type: "number",
        default: DEFAULT_LIMIT,
        description: "How many recent events.",
      },
    },
    required: ["projectPath"],
  },
};
