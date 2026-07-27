// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  CALL_TIMEOUT,
  SESSION_BROWSER,
  SESSION_PROJECT_PATH,
} from "../lib/common-schema";
import {
  runActVerb,
  actFrameJson,
  patchValue,
  type ActArgs,
} from "../lib/act";
import { envelope } from "../lib/envelope";
import { resolveSessionBrowser } from "../lib/session-browser";
import { isChromiumFamily, isGeckoFamily } from "../lib/browser-family";
import {
  resolveCdpPort,
  resolveRdpPort,
  CDP_PORT_MISSING_HINT,
  RDP_PORT_MISSING_HINT,
} from "../lib/cdp-port";
import {
  listPageTargets,
  matchTargetsByUrl,
  TARGET_ID_NOTE,
} from "../lib/cdp-targets";
import { rdpListTabs } from "../lib/rdp";
import { listBridgeTabs, matchTabsByUrl } from "../lib/bridge-tabs";

const RDP_ACTOR_NOTE =
  "actor is an RDP tab descriptor actor id, NOT a chrome.tabs id: do not pass it as `tab`. " +
  "Target a tab with `tabUrl` (URL substring) or `url`; if you need a numeric tab id, call extension_dom_snapshot with listTabs: true.";

export const schema = {
  name: "extension_dom_snapshot",
  description:
    "Take a shallow structured DOM snapshot of one chosen surface through the agent bridge (localhost only; the snapshot itself needs no CDP, but listTargets and `tabUrl` resolution ask the browser directly and need the session's debug port: CDP page targets on Chromium, RDP tab descriptors on Firefox): element counts, extension roots, open shadow roots, optional byte-capped HTML, and optional recent console lines. This is the SURFACE PICKER: the only tool that reads an open extension surface by name (`context`: popup, options, sidebar, devtools) or an override page, the only one that takes a numeric chrome.tabs id, and the only one that enumerates what is open (listTargets for CDP targetIds and RDP tab actors, listTabs for numeric tab ids). An ambiguous `tabUrl` returns the candidates instead of guessing. It does not pierce closed shadow roots, run selector probes, or navigate: use extension_inspect for those, and for a deep read of an already-open web page. Start the session with allowControl:true (extension_dev).",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      tab: { type: "number", description: "Numeric chrome.tabs id, only to disambiguate when several tabs match. With neither `tab` nor `url`, content/page target the active tab." },
      url: { type: "string", description: "content/page: pick the tab by url (match pattern, then substring). Preferred over `tab`." },
      tabUrl: {
        type: "string",
        description:
          "Target the tab whose URL contains this substring (case-insensitive; titles checked only when no url matches). Resolved against the live browser first: exactly one match proceeds, zero or several return the candidates instead of a guess. Alternative to `url`.",
      },
      listTargets: {
        type: "boolean",
        default: false,
        description:
          "Enumerate live page targets and return, ignoring the other args. The discovery path for `tabUrl`. Chromium: {targetId,url,title,type}. Firefox: RDP tab descriptors {actor,url,title,type}. Neither id is a numeric chrome.tabs id; for those use listTabs.",
      },
      listTabs: {
        type: "boolean",
        default: false,
        description:
          "Enumerate open tabs as {tabId,url,title} and return, ignoring the other args. Use when you need a numeric tab id.",
      },
      context: {
        type: "string",
        enum: ["content", "page", "popup", "options", "sidebar", "devtools", "newtab", "history", "bookmarks"],
        default: "content",
        description:
          "content/page targets `url`, else the active tab; the rest must already be OPEN",
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
          "Also include recent console lines. A number is how many; true means 50.",
      },
      browser: SESSION_BROWSER,
      timeout: CALL_TIMEOUT,
    },
    required: ["projectPath"],
  },
};

async function cdpPortOrError(
  projectPath: string,
  browser: string,
  feature: string,
): Promise<{ port: number } | { error: string }> {
  if (!isChromiumFamily(browser)) {
    return {
      error: envelope({
        ok: false,
        command: schema.name,
        status: "unsupported-browser",
        error: {
          code: "E_UNSUPPORTED_BROWSER",
          name: "Unsupported",
          message: `${feature} reads the browser's CDP page targets, which ${browser} (Gecko) does not expose. Target the tab with \`url\` or \`tab\` instead, and discover tabs with listTabs: true (agent bridge, works on every browser).`,
        },
      }),
    };
  }
  const resolved = await resolveCdpPort(projectPath, browser);
  if (!resolved) {
    return {
      error: envelope({
        ok: false,
        command: schema.name,
        status: "no-session",
        error: {
          code: "E_NO_SESSION",
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
  const withConsole =
    args.withConsole === true ? 50 : args.withConsole === false ? undefined : args.withConsole;

  if (args.listTargets) {
    const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
    if (isGeckoFamily(browser)) {
      const resolved = await resolveRdpPort(args.projectPath, browser);
      if (!resolved) {
        return envelope({
          ok: false,
          command: schema.name,
          status: "no-session",
          error: {
            code: "E_NO_SESSION",
            name: "NoSession",
            message: `No active dev session with a Firefox debugger server (RDP) for ${browser}, so listTargets has no browser to ask. Start extension_dev and extension_wait for ready. ${RDP_PORT_MISSING_HINT}`,
          },
        });
      }
      try {
        const tabs = await rdpListTabs(resolved.port);
        return envelope({
          ok: true,
          command: schema.name,
          status: "listed-targets",
          value: {
            browser,
            transport: "rdp",
            targets: tabs.map((t) => ({
              actor: String(t.actor ?? ""),
              type: "tab",
              url: String(t.url ?? ""),
              title: String(t.title ?? ""),
              ...(t.selected === true ? { selected: true } : {}),
            })),
          },
          warnings: [RDP_ACTOR_NOTE],
        });
      } catch (e) {
        return envelope({
          ok: false,
          command: schema.name,
          status: "rdp-failed",
          error: {
            code: "E_RDP",
            name: "RdpError",
            message: `Could not list tab targets over RDP: ${e instanceof Error ? e.message : String(e)}`,
          },
          hint: "Confirm the session is ready (extension_wait), then retry. listTabs: true is the bridge alternative (needs allowControl).",
        });
      }
    }
    const cdp = await cdpPortOrError(args.projectPath, browser, "listTargets");
    if ("error" in cdp) return cdp.error;
    try {
      const targets = await listPageTargets(cdp.port);
      return envelope({
        ok: true,
        command: schema.name,
        status: "listed-targets",
        value: { browser, targets },
        warnings: [TARGET_ID_NOTE],
      });
    } catch (e) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "cdp-failed",
        error: {
          code: "E_CDP",
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
      schema.name,
    );
  }

  let targetUrl = args.url;
  let targetTab = args.tab;
  let resolvedTarget: Record<string, unknown> | null = null;
  if (args.tabUrl) {
    if (args.tab != null || args.url) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "bad-request",
        error: {
          code: "E_BAD_REQUEST",
          name: "BadRequest",
          message:
            "Pass ONE tab selector: `tabUrl` (URL substring, resolved against live targets), `url` (engine-side match), or `tab` (numeric chrome.tabs id), not several.",
        },
      });
    }
    const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
    if (!isChromiumFamily(browser)) {
      const listed = await listBridgeTabs(
        args.projectPath,
        browser,
        args.timeout,
      );
      if ("error" in listed) return listed.error;
      const matches = matchTabsByUrl(listed.tabs, args.tabUrl);
      if (matches.length === 0) {
        return envelope({
          ok: false,
          command: schema.name,
          status: "no-matching-target",
          error: {
            code: "E_NO_MATCHING_TARGET",
            name: "NoMatchingTarget",
            message: `No open tab's url (or title) contains "${args.tabUrl}" (case-insensitive).`,
          },
          value: { availableTabs: listed.tabs },
          hint: "Pick one from availableTabs and retry with a `tabUrl` substring of its url, or open the page first (extension_open with `url`).",
        });
      }
      if (matches.length > 1) {
        return envelope({
          ok: false,
          command: schema.name,
          status: "ambiguous-target",
          error: {
            code: "E_AMBIGUOUS_TARGET",
            name: "AmbiguousTabUrl",
            message: `${matches.length} tabs match "${args.tabUrl}"; refusing to guess which tab you mean.`,
          },
          value: { matchingTabs: matches },
          hint: "Narrow `tabUrl` to a longer substring that matches exactly one url in matchingTabs, or pass its numeric tabId as `tab`.",
        });
      }
      resolvedTarget = { ...matches[0] };
      if (matches[0].tabId != null) targetTab = matches[0].tabId;
      else targetUrl = matches[0].url;
    } else {
      const cdp = await cdpPortOrError(args.projectPath, browser, "tabUrl");
      if ("error" in cdp) return cdp.error;
      let targets: Awaited<ReturnType<typeof listPageTargets>>;
      try {
        targets = await listPageTargets(cdp.port);
      } catch (e) {
        return envelope({
          ok: false,
          command: schema.name,
          status: "cdp-failed",
          error: {
            code: "E_CDP",
            name: "CdpError",
            message: `Could not list page targets to resolve tabUrl: ${e instanceof Error ? e.message : String(e)}`,
          },
          hint: "Confirm the session is ready (extension_wait), then retry, or target with `url`/`tab` instead.",
        });
      }
      const matches = matchTargetsByUrl(targets, args.tabUrl);
      if (matches.length === 0) {
        return envelope({
          ok: false,
          command: schema.name,
          status: "no-matching-target",
          error: {
            code: "E_NO_MATCHING_TARGET",
            name: "NoMatchingTarget",
            message: `No open page target's url (or title) contains "${args.tabUrl}" (case-insensitive).`,
          },
          value: { availableTargets: targets },
          hint: `Pick one from availableTargets and retry with a \`tabUrl\` substring of its url, or open the page first (extension_open with \`url\`). ${TARGET_ID_NOTE}`,
        });
      }
      if (matches.length > 1) {
        return envelope({
          ok: false,
          command: schema.name,
          status: "ambiguous-target",
          error: {
            code: "E_AMBIGUOUS_TARGET",
            name: "AmbiguousTabUrl",
            message: `${matches.length} page targets match "${args.tabUrl}"; refusing to guess which tab you mean.`,
          },
          value: { matchingTargets: matches },
          hint: `Narrow \`tabUrl\` to a longer substring that matches exactly one url in matchingTargets. ${TARGET_ID_NOTE}`,
        });
      }
      resolvedTarget = { ...matches[0] };
      targetUrl = matches[0].url;
    }
  }

  const cli = ["inspect", args.projectPath];
  if (targetTab != null) cli.push("--tab", String(targetTab));
  if (targetUrl) cli.push("--url", targetUrl);
  if (args.context) cli.push("--context", args.context);
  if (args.include?.length) cli.push("--include", args.include.join(","));
  if (args.maxBytes != null) cli.push("--max-bytes", String(args.maxBytes));
  if (withConsole != null) cli.push("--with-console", String(withConsole));
  cli.push("--browser", resolveSessionBrowser(args.projectPath, args.browser).browser);
  if (args.timeout != null) cli.push("--timeout", String(args.timeout));
  const raw = await runActVerb(cli, args.projectPath, args.timeout, schema.name);
  if (!resolvedTarget) return raw;
  try {
    const parsed = JSON.parse(raw);
    patchValue(parsed, {
      resolvedTarget: { ...resolvedTarget, matchedBy: "tabUrl" },
    });
    return actFrameJson(parsed);
  } catch {
    return raw;
  }
}
