// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import {
  DEFAULT_LIMIT,
  DEFAULT_FOLLOW_MS,
  MIN_FOLLOW_MS,
  MAX_FOLLOW_MS,
} from "./logs-constants";

export const schema = {
  name: "extension_logs",
  description:
    "Read or stream logs from every context of a running dev session (service worker, content scripts, popup, options, sidebar, devtools, pages) in one ordered timeline. Reads the same agent-bridge plane as the `extension logs` CLI: a one-shot returns the most recent matching lines from logs.ndjson; `follow:true` collects from the live control channel for a bounded window. Requires an active `extension dev` session.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description:
          "Path to the extension project root (must have an active dev session)",
      },
      browser: {
        type: "string",
        description:
          "Which dist/extension-js/<browser>/ to read. Defaults to the active dev session's browser for this project (falls back to chromium).",
      },
      level: {
        type: "string",
        enum: ["off", "error", "warn", "info", "debug", "trace", "all"],
        default: "all",
        description:
          "Minimum severity to include; selecting a level includes it plus everything more severe.",
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
          ],
        },
        description: "Restrict to these contexts. Omit for all.",
      },
      signalsOnly: {
        type: "boolean",
        default: false,
        description:
          "Only structured dx.signal diagnostics (which carry code/status/remediation), skipping plain console lines.",
      },
      since: {
        type: "number",
        description:
          "Only return events with seq greater than this (cursor for polling forward).",
      },
      url: {
        type: "string",
        description:
          "Only events whose url/hostname matches (glob with * or plain substring), e.g. https://shop.example/*.",
      },
      tab: {
        type: "number",
        description: "Only events from this tab id.",
      },
      follow: {
        type: "boolean",
        default: false,
        description:
          "Collect from the live control channel for a bounded window instead of reading the file. Use with followMs.",
      },
      followMs: {
        type: "number",
        default: DEFAULT_FOLLOW_MS,
        description: `How long to collect live frames when follow=true (clamped ${MIN_FOLLOW_MS}–${MAX_FOLLOW_MS}ms).`,
      },
      limit: {
        type: "number",
        default: DEFAULT_LIMIT,
        description: "Maximum number of (most recent) events to return.",
      },
    },
    required: ["projectPath"],
  },
};
