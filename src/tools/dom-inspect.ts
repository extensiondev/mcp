// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { runActVerb, type ActArgs } from "../lib/act";
import { resolveSessionBrowser } from "../lib/session-browser";
import { isChromiumFamily } from "../lib/browser-family";
import { resolveCdpPort, CDP_PORT_MISSING_HINT } from "../lib/cdp-port";
import {
  listPageTargets,
  matchTargetsByUrl,
  TARGET_ID_NOTE,
} from "../lib/cdp-targets";

export const schema = {
  name: "extension_dom_inspect",
  description:
    "Inspect a page/content-script DOM via the agent bridge (CDP-free, localhost). Returns a structured snapshot (counts, extension roots, open shadow roots, optional capped HTML). Target a tab by `tabUrl` (case-insensitive URL substring resolved against the browser's live page targets; zero or several matches return the candidates instead of guessing), by `url`, or by numeric `tab`. Discover what is open with listTargets: true (CDP targetIds) or listTabs: true (numeric chrome.tabs ids). Requires the dev session to be started with allowControl: true (extension_dev). For closed shadow roots or deep CDP inspection use extension_source_inspect. Wraps `extension inspect`.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root (must have an active dev session)",
      },
      tab: { type: "number", description: "Numeric chrome.tabs id, for disambiguating when several tabs match. Optional: with neither `tab` nor `url`, content/page target the active tab." },
      url: { type: "string", description: "For content/page: selects the target tab by url (match pattern, then substring fallback). Preferred over `tab`." },
      tabUrl: {
        type: "string",
        description:
          "Target the tab whose URL contains this substring (case-insensitive; titles are checked only when no url matches). Resolved against the live browser's CDP page targets BEFORE inspecting: exactly one match proceeds; zero or several matches return the candidate targets (targetId/url/title) so you can narrow, never a guess. Chromium sessions only; on Firefox use `url`/`tab`. Alternative to `url`.",
      },
      listTargets: {
        type: "boolean",
        default: false,
        description:
          "Enumerate the browser's CDP page targets as {targetId,url,title,type} and return, ignoring the other args. The discovery path for `tabUrl`. targetId is a CDP target id, NOT a numeric chrome.tabs id (for those use listTabs).",
      },
      listTabs: {
        type: "boolean",
        default: false,
        description:
          "Enumerate open tabs as {tabId,url,title} and return, ignoring the other args. The discovery path when you need an explicit numeric tab id.",
      },
      context: {
        type: "string",
        enum: ["content", "page", "popup", "options", "sidebar", "devtools", "newtab", "history", "bookmarks"],
        default: "content",
        description:
          "content/page (targets `url`, else the active tab), an OPEN extension surface (popup/options/sidebar/devtools), or an override page (newtab/history/bookmarks)",
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

// Resolve the session's CDP port, or say precisely which arg gets the caller
// unstuck. Shared by listTargets and tabUrl, the two CDP-backed paths.
async function cdpPortOrError(
  projectPath: string,
  browser: string,
  feature: string,
): Promise<{ port: number } | { error: string }> {
  if (!isChromiumFamily(browser)) {
    return {
      error: JSON.stringify({
        ok: false,
        error: {
          name: "Unsupported",
          message: `${feature} reads the browser's CDP page targets, which ${browser} (Gecko) does not expose. Target the tab with \`url\` or \`tab\` instead, and discover tabs with listTabs: true (agent bridge, works on every browser).`,
        },
      }),
    };
  }
  const resolved = await resolveCdpPort(projectPath, browser);
  if (!resolved) {
    return {
      error: JSON.stringify({
        ok: false,
        error: {
          name: "NoSession",
          message: `No active dev session / CDP port for ${browser}, so ${feature} has no browser to ask. Start extension_dev and extension_wait for ready. ${CDP_PORT_MISSING_HINT}`,
        },
      }),
    };
  }
  return { port: resolved.port };
}

export async function handler(
  args: ActArgs & {
    tab?: number;
    url?: string;
    tabUrl?: string;
    listTargets?: boolean;
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

  // Discovery without a separate tool: the page targets straight from the
  // debugging endpoint, so a caller can see what is open before targeting it.
  if (args.listTargets) {
    const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
    const cdp = await cdpPortOrError(args.projectPath, browser, "listTargets");
    if ("error" in cdp) return cdp.error;
    try {
      const targets = await listPageTargets(cdp.port);
      return JSON.stringify({
        ok: true,
        browser,
        targets,
        note: TARGET_ID_NOTE,
      });
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error: {
          name: "CdpError",
          message: `Could not list page targets: ${e instanceof Error ? e.message : String(e)}`,
        },
        hint: "Confirm the session is ready (extension_wait), then retry. listTabs: true is the CDP-free alternative.",
      });
    }
  }

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

  // `tabUrl` targets by what a human can see: a substring of the tab's URL,
  // resolved against the live CDP page targets. It only ever proceeds on a
  // UNIQUE match; anything else returns the candidates so the caller picks,
  // because guessing among tabs is how inspection reads the wrong page.
  let targetUrl = args.url;
  let resolvedTarget: { targetId: string; url: string; title: string } | null =
    null;
  if (args.tabUrl) {
    if (args.tab != null || args.url) {
      return JSON.stringify({
        ok: false,
        error: {
          name: "BadRequest",
          message:
            "Pass ONE tab selector: `tabUrl` (URL substring, resolved against live targets), `url` (engine-side match), or `tab` (numeric chrome.tabs id), not several.",
        },
      });
    }
    const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
    const cdp = await cdpPortOrError(args.projectPath, browser, "tabUrl");
    if ("error" in cdp) return cdp.error;
    let targets: Awaited<ReturnType<typeof listPageTargets>>;
    try {
      targets = await listPageTargets(cdp.port);
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error: {
          name: "CdpError",
          message: `Could not list page targets to resolve tabUrl: ${e instanceof Error ? e.message : String(e)}`,
        },
        hint: "Confirm the session is ready (extension_wait), then retry, or target with `url`/`tab` instead.",
      });
    }
    const matches = matchTargetsByUrl(targets, args.tabUrl);
    if (matches.length === 0) {
      return JSON.stringify({
        ok: false,
        error: {
          name: "NoMatchingTarget",
          message: `No open page target's url (or title) contains "${args.tabUrl}" (case-insensitive).`,
        },
        availableTargets: targets,
        hint: `Pick one from availableTargets and retry with a \`tabUrl\` substring of its url, or open the page first (extension_open with \`url\`). ${TARGET_ID_NOTE}`,
      });
    }
    if (matches.length > 1) {
      return JSON.stringify({
        ok: false,
        error: {
          name: "AmbiguousTabUrl",
          message: `${matches.length} page targets match "${args.tabUrl}"; refusing to guess which tab you mean.`,
        },
        matchingTargets: matches,
        hint: `Narrow \`tabUrl\` to a longer substring that matches exactly one url in matchingTargets. ${TARGET_ID_NOTE}`,
      });
    }
    resolvedTarget = matches[0];
    // Hand the engine the matched tab's EXACT url: uniqueness was just proven
    // against the live target list, so the engine-side match cannot fan out.
    targetUrl = resolvedTarget.url;
  }

  // No tab-id precondition any more. The engine's executor resolves the target
  // from `url` and otherwise falls back to the active tab (upstream #51), so
  // refusing here would block the very path that now works and push callers to
  // source_inspect for something dom_inspect can do.
  const cli = ["inspect", args.projectPath];
  if (args.tab != null) cli.push("--tab", String(args.tab));
  if (targetUrl) cli.push("--url", targetUrl);
  if (args.context) cli.push("--context", args.context);
  if (args.include?.length) cli.push("--include", args.include.join(","));
  if (args.maxBytes != null) cli.push("--max-bytes", String(args.maxBytes));
  if (withConsole != null) cli.push("--with-console", String(withConsole));
  cli.push("--browser", resolveSessionBrowser(args.projectPath, args.browser).browser);
  if (args.timeout != null) cli.push("--timeout", String(args.timeout));
  const raw = await runActVerb(cli, args.projectPath, args.timeout);
  if (!resolvedTarget) return raw;
  // Say which tab the substring resolved to, so the caller can verify the
  // match without a second discovery round-trip.
  try {
    const parsed = JSON.parse(raw);
    parsed.resolvedTarget = { ...resolvedTarget, matchedBy: "tabUrl" };
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}
