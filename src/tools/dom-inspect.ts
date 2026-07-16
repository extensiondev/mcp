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
      tab: { type: "number", description: "Tab id (required for content/page; omit for surfaces)" },
      context: {
        type: "string",
        enum: ["content", "page", "popup", "options", "sidebar", "devtools"],
        default: "content",
        description:
          "content/page (needs tab) or an OPEN extension surface (popup/options/sidebar/devtools)",
      },
      include: {
        type: "array",
        items: { type: "string", enum: ["summary", "html"] },
        default: ["summary"],
        description: "What to include; html is byte-capped",
      },
      maxBytes: { type: "number", default: 262144 },
      withConsole: {
        type: "number",
        description: "Also include the last N console lines for the target (DOM + recent console in one call)",
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
    include?: string[];
    maxBytes?: number;
    withConsole?: number;
  },
): Promise<string> {
  const surfaces = ["popup", "options", "sidebar", "devtools"];
  const isSurface = !!args.context && surfaces.includes(args.context);
  if (!isSurface && args.tab == null) {
    return JSON.stringify({
      ok: false,
      error: { name: "BadRequest", message: "content/page inspect requires a tab id" },
    });
  }
  const cli = ["inspect", args.projectPath];
  if (args.tab != null) cli.push("--tab", String(args.tab));
  if (args.context) cli.push("--context", args.context);
  if (args.include?.length) cli.push("--include", args.include.join(","));
  if (args.maxBytes != null) cli.push("--max-bytes", String(args.maxBytes));
  if (args.withConsole != null) cli.push("--with-console", String(args.withConsole));
  cli.push("--browser", resolveSessionBrowser(args.projectPath, args.browser).browser);
  if (args.timeout != null) cli.push("--timeout", String(args.timeout));
  return runActVerb(cli, args.projectPath, args.timeout);
}
