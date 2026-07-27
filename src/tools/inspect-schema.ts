// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  SESSION_BROWSER,
  SESSION_PROJECT_PATH,
} from "../lib/common-schema";

export const schema = {
  name: "extension_inspect",
  description:
    "Inspect a running extension deeply over the browser's debugger protocol: full HTML including shadow DOM, DOM structure, content-script injection, console messages, and CSS selector queries through `probe`. This is the ONLY tool that pierces closed shadow roots (deepDom), runs selector probes, and navigates a tab to `url` before reading it. It reads a web or override page and picks the first inspectable target, or the first whose url contains `url`; it cannot address an extension surface by name and takes no chrome.tabs id. Use extension_dom_snapshot to choose which tab or which open surface (popup, options, sidebar, devtools) to read, or to enumerate what is open. Use extension_analyze for a built extension's files and sizes on disk. Chromium rides the Chrome DevTools Protocol and needs the session's debug port, not allowControl. Firefox is fully paired: summary, meta, html, dom_snapshot, extension_roots and probes ride the agent bridge and need allowEval:true, console rides the RDP watcher replay on engine 4.0.15 and later, and deepDom needs an MV2 session with host permissions for the target url, because the Firefox MV3 background CSP blocks bridge evals. This requires an active dev or start session.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      url: {
        type: "string",
        description:
          "URL to inspect; the tab is navigated there first",
      },
      probe: {
        type: "array",
        items: { type: "string" },
        description:
          "CSS selectors to query; returns counts and samples for each",
      },
      include: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "html",
            "summary",
            "meta",
            "dom_snapshot",
            "console",
            "extension_roots",
          ],
        },
        default: ["summary", "meta", "console"],
        description: "What to include",
      },
      browser: SESSION_BROWSER,
      maxBytes: {
        type: "number",
        default: 262144,
        description: "Truncate HTML output at this byte count (0 = unlimited)",
      },
      deepDom: {
        type: "boolean",
        default: false,
        description:
          "Pierce CLOSED shadow roots; open ones are read anyway. Chromium: CDP DOM pierce. Firefox: a content-script walk via tabs.executeScript (MV2 only, needs host permissions for the target url).",
      },
    },
    required: ["projectPath"],
  },
};
