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
    "Read or stream logs from every context of a running dev session (service worker, content scripts, popup, options, sidebar, devtools, pages) in one ordered timeline. This reads the same agent-bridge plane as the `extension logs` CLI: a one-shot returns the most recent matching lines from logs.ndjson, and follow:true collects from the live control channel for a bounded window. This requires an active extension_dev session.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      browser: {
        type: "string",
        description:
          "Which dist/extension-js/<browser>/ to read. Defaults to this project's live session, else chromium.",
      },
      level: {
        type: "string",
        enum: ["off", "error", "warn", "info", "debug", "trace", "all"],
        default: "all",
        description:
          "Minimum severity; a level includes everything more severe.",
      },
      context: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "background",
            "content",
            "page",
            "sidebar",
            "popup",
            "options",
            "devtools",
            "newtab",
            "history",
            "bookmarks",
          ],
        },
        description: "Restrict to these contexts. Omit for all.",
      },
      signalsOnly: {
        type: "boolean",
        default: false,
        description:
          "Only structured dx.signal diagnostics (code/status/remediation), no plain console lines.",
      },
      since: {
        type: "number",
        description:
          "Only events with seq greater than this; the cursor for polling forward.",
      },
      url: {
        type: "string",
        description:
          "Only events whose url/hostname matches (glob or substring), e.g. https://shop.example/*.",
      },
      tab: {
        type: "number",
        description: "Only events from this tab id.",
      },
      follow: {
        type: "boolean",
        default: false,
        description:
          "Collect from the live control channel for a bounded window instead of reading the file.",
      },
      followMs: {
        type: "number",
        default: DEFAULT_FOLLOW_MS,
        description: `How long to collect live frames when follow=true (clamped ${MIN_FOLLOW_MS}–${MAX_FOLLOW_MS}ms).`,
      },
      limit: {
        type: "number",
        default: DEFAULT_LIMIT,
        description: "How many of the most recent events to return.",
      },
    },
    required: ["projectPath"],
  },
};
