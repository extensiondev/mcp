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
import { HTML_DEFAULT_MAX_BYTES } from "../lib/html-cap";
import { TARGET_ID_PROPERTY } from "../lib/target-pick";

export const schema = {
  name: "extension_inspect",
  description:
    "Inspect a web page or targetId in a running session: its HTML, DOM, console and CSS selector counts, closed shadow roots included. Answers html, dom and console for a web page; extension_dom_snapshot answers an extension surface, extension_element_act acts on one element, extension_eval runs code, extension_logs answers console history. Firefox goes through the agent bridge and needs allowEval.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      url: {
        type: "string",
        description:
          "Navigate here first, or the url substring to pick.",
      },
      targetId: TARGET_ID_PROPERTY,
      probe: {
        type: "array",
        items: { type: "string" },
        description:
          "CSS selectors to count and sample.",
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
        description: "Sections to answer; fewer sections, a smaller answer.",
      },
      browser: SESSION_BROWSER,
      maxBytes: {
        type: "number",
        default: HTML_DEFAULT_MAX_BYTES,
        description: "HTML byte cap (0 = none).",
      },
      deepDom: {
        type: "boolean",
        default: false,
        description:
          "Pierce closed shadow roots; other open roots are not crossed.",
      },
    },
    required: ["projectPath"],
  },
};
