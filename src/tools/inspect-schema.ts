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
import { TARGET_ID_PROPERTY } from "../lib/target-pick";

export const schema = {
  name: "extension_inspect",
  description:
    "Inspect a running extension deeply over the browser's debugger protocol: full HTML (open shadow roots of the extension-root hosts inlined; other shadow roots are not crossed by html, dom_snapshot or probe), DOM structure, content-script injection, console messages, and CSS selector queries through `probe`. This is the ONLY tool that pierces closed shadow roots (deepDom), runs selector probes, and navigates a tab to `url` before reading it. It reads a web or override page: the first inspectable target, the first whose url contains `url`, or the exact page `targetId` names (the target.targetId extension_open answers, or one from extension_dom_snapshot listTargets) without navigating. Not for an extension surface by name (popup, options, sidebar, devtools) or a chrome.tabs id, and not for enumerating what is open: that is extension_dom_snapshot. Not for a built extension's files on disk: that is extension_analyze. Chromium rides the Chrome DevTools Protocol and needs the session's debug port, not allowControl; on Firefox the reads ride the agent bridge and need allowEval:true (console rides the RDP watcher replay on engine 4.0.15 and later). This requires an active dev or start session.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      url: {
        type: "string",
        description:
          "Navigate the picked tab here before reading, or, with no navigation wanted, the substring the target's url must contain; a url that matches several tabs showing the same page reads the most recently active one and warns with the others' targetIds, so pass `targetId` to pick one exactly.",
      },
      targetId: TARGET_ID_PROPERTY,
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
          "Pierce CLOSED shadow roots (open roots of the extension-root hosts are already inlined in html; other open roots are not read). Chromium: CDP DOM pierce. Firefox: a content-script walk via tabs.executeScript (MV2 only, needs host permissions for the target url); the answer says whether that context could see closed roots at all.",
      },
    },
    required: ["projectPath"],
  },
};
