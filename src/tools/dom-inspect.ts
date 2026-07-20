// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { runActVerb, type ActArgs } from "../lib/act";
import { resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_dom_inspect",
  description:
    "Inspect a page/content-script DOM via the agent bridge (CDP-free, localhost). Returns a structured snapshot (counts, extension roots, open shadow roots, optional capped HTML). Requires the dev session to be started with allowControl: true (extension_dev). For closed shadow roots or deep CDP inspection use extension_source_inspect. Wraps `extension inspect`.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root (must have an active dev session)",
      },
      tab: { type: "number", description: "Numeric chrome.tabs id, for disambiguating when several tabs match. Optional: with neither `tab` nor `url`, content/page target the active tab." },
      url: { type: "string", description: "For content/page: selects the target tab by url (match pattern, then substring fallback). Preferred over `tab`." },
      listTabs: {
        type: "boolean",
        default: false,
        description:
          "Enumerate open tabs as {tabId,url,title} and return, ignoring the other args. The discovery path when you need an explicit numeric tab id.",
      },
      context: {
        type: "string",
        enum: ["content", "page", "popup", "options", "sidebar", "devtools"],
        default: "content",
        description:
          "content/page (targets `url`, else the active tab) or an OPEN extension surface (popup/options/sidebar/devtools)",
      },
      include: {
        type: "array",
        items: { type: "string", enum: ["summary", "html"] },
        default: ["summary"],
        description: "What to include; html is byte-capped",
      },
      maxBytes: { type: "number", default: 262144 },
      withConsole: {
        type: ["number", "boolean"],
        description:
          "Also include recent console lines for the target (DOM + console in one call). A number is how many lines; true means 50.",
      },
      browser: {
        type: "string",
        description:
          "Browser session to target. Defaults to the active dev session's browser for this project.",
      },
      timeout: { type: "number", description: "Command timeout in ms (default 5000)" },
    },
    required: ["projectPath"],
  },
};

export async function handler(
  args: ActArgs & {
    tab?: number;
    url?: string;
    listTabs?: boolean;
    include?: string[];
    maxBytes?: number;
    withConsole?: number | boolean;
  },
): Promise<string> {
  // `withConsole: true` reads as the obvious way to ask for console output; it
  // used to be a type error because the arg only accepted a line count.
  const withConsole =
    args.withConsole === true ? 50 : args.withConsole === false ? undefined : args.withConsole;
  if (args.listTabs) {
    return runActVerb(
      [
        "inspect",
        args.projectPath,
        "--list-tabs",
        "--browser",
        resolveSessionBrowser(args.projectPath, args.browser).browser,
        ...(args.timeout != null ? ["--timeout", String(args.timeout)] : []),
      ],
      args.projectPath,
      args.timeout,
    );
  }

  // No tab-id precondition any more. The engine's executor resolves the target
  // from `url` and otherwise falls back to the active tab (upstream #51), so
  // refusing here would block the very path that now works and push callers to
  // source_inspect for something dom_inspect can do.
  const cli = ["inspect", args.projectPath];
  if (args.tab != null) cli.push("--tab", String(args.tab));
  if (args.url) cli.push("--url", args.url);
  if (args.context) cli.push("--context", args.context);
  if (args.include?.length) cli.push("--include", args.include.join(","));
  if (args.maxBytes != null) cli.push("--max-bytes", String(args.maxBytes));
  if (withConsole != null) cli.push("--with-console", String(withConsole));
  cli.push("--browser", resolveSessionBrowser(args.projectPath, args.browser).browser);
  if (args.timeout != null) cli.push("--timeout", String(args.timeout));
  return runActVerb(cli, args.projectPath, args.timeout);
}
