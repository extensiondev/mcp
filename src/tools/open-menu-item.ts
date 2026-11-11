// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isChromiumFamily } from "../lib/browser-family";
import { CDP_PORT_MISSING_HINT, resolveCdpPort } from "../lib/cdp-port";
import { replayContextMenuClick, type MenuReplayOutcome } from "../lib/context-menu-replay";
import { envelope, type EnvelopeInit } from "../lib/envelope";
import { noSessionEnvelope } from "../lib/production-receipt";

const COMMAND = "extension_open";

export interface MenuItemArgs {
  projectPath: string;
  menuItemId: string;
  tab?: number;
  timeout?: number;
}

const refuse = (init: Omit<EnvelopeInit, "ok" | "command">): string => envelope({ ok: false, command: COMMAND, ...init });

const NO_GESTURE = "The replay carries no user gesture, so no activeTab grant came with it.";

function replayedAnswer(args: MenuItemArgs, outcome: Extract<MenuReplayOutcome, { kind: "replayed" }>): string {
  const tabWords = outcome.tab?.id !== undefined ? `tab ${outcome.tab.id}${outcome.tab.url ? ` (${outcome.tab.url})` : ""}` : "no tab (the browser listed no active tab)";

  return envelope({
    ok: true,
    command: COMMAND,
    status: "replayed",
    value: {
      surface: "action",
      replayed: "contextMenus.onClicked",
      menuItemId: args.menuItemId,
      tab: outcome.tab,
      info: outcome.info,
      route: "debug-port",
      worker: outcome.worker,
      gesture: false,
      trusted: false,
    },
    hint:
      `contextMenus.onClicked was dispatched in the extension's service worker with info.menuItemId ${JSON.stringify(args.menuItemId)} for ${tabWords}, so its listeners ran as if the person had picked that item from the toolbar icon's menu. ${NO_GESTURE} ` +
      "The id was not checked against the registered items, since Chrome lists none: a listener that matches on another id does nothing. Read what the listener did with extension_logs, extension_storage or extension_dom_snapshot.",
  });
}

function outcomeAnswer(args: MenuItemArgs, browser: string, outcome: MenuReplayOutcome): string {
  switch (outcome.kind) {
    case "replayed":
      return replayedAnswer(args, outcome);
    case "no-background":
      return refuse({
        status: "no-background",
        error: {
          code: "E_NO_BACKGROUND",
          name: "NoBackground",
          message: `No background of this extension runs in the ${browser} session to dispatch contextMenus.onClicked in: ${outcome.reason}. Nothing was replayed.`,
        },
        hint: "A context menu listener lives in the background (service worker). Confirm the session is ready (extension_wait) and the manifest declares a background, then call again.",
      });
    case "no-listener":
      return refuse({
        status: "no-listener",
        error: {
          code: "E_NO_LISTENER",
          name: "NoListener",
          message: "The extension's service worker has no contextMenus.onClicked listener registered right now, so there is nothing to replay; nothing was dispatched.",
        },
        hint: "A listener added at the top level of the service worker is there on every start; one added inside an async callback or after an await is missing when the worker restarts, which is also what Chrome itself would drop. extension_logs shows the worker's startup.",
      });
    case "no-api":
      return refuse({
        status: "no-context-menus",
        error: {
          code: "E_NO_CONTEXT_MENUS",
          name: "NoContextMenus",
          message: "chrome.contextMenus is not available in the extension's service worker, so no menu item of it can be clicked; nothing was done.",
        },
        hint: 'Add "contextMenus" to the manifest permissions and rebuild; the listener then registers on chrome.contextMenus.onClicked.',
      });
    case "no-dispatch":
      return refuse({
        status: "unsupported-browser",
        error: {
          code: "E_UNSUPPORTED_BROWSER",
          name: "Unsupported",
          message: `This ${browser} exposes no dispatch on its extension event objects, so contextMenus.onClicked cannot be replayed from the debug port, and the dev session's control channel carries no context menu verb; nothing was done.`,
        },
        hint: "Exercise the item by hand: open the toolbar icon's menu in the dev browser and pick it, then read extension_logs.",
      });
    case "no-tab":
      return refuse({
        status: "tab-not-found",
        error: {
          code: "E_TAB_NOT_FOUND",
          name: "TabNotFound",
          message: `The tab for the click could not be read (${outcome.message}), so nothing was dispatched.`,
        },
        hint: "Pass a chrome.tabs id from extension_dom_snapshot with listTabs: true, or omit tab to use the active tab.",
      });
    default:
      return refuse({
        status: outcome.timedOut ? "cdp-timeout" : "cdp-failed",
        error: {
          code: "E_CDP",
          name: outcome.timedOut ? "CdpTimeout" : "CdpError",
          message: `${outcome.message} The replay may have run in part; read extension_logs before repeating it.`,
        },
        hint: "The session's debug port refused the call or the worker went away. extension_doctor names which; a session that ended needs extension_dev again.",
      });
  }
}

export function menuItemNeedsAction(surface: string | undefined): string {
  return refuse({
    status: "bad-request",
    error: {
      code: "E_BAD_REQUEST",
      name: "BadRequest",
      message: `menuItemId replays contextMenus.onClicked, which goes with surface: "action", got ${surface === undefined ? "no surface" : `surface: ${JSON.stringify(surface)}`}. Nothing was opened or replayed.`,
    },
    hint: 'Call again with surface: "action" and the same menuItemId, or drop menuItemId to open the surface.',
  });
}

export async function replayMenuItem(args: MenuItemArgs, browser: string): Promise<string> {
  if (args.tab !== undefined && !(Number.isInteger(args.tab) && args.tab > 0)) {
    return refuse({
      status: "bad-request",
      error: {
        code: "E_BAD_REQUEST",
        name: "BadRequest",
        message: `\`tab\` expects a chrome.tabs id (a positive integer), got: ${JSON.stringify(args.tab)}. Nothing was replayed.`,
      },
      hint: "extension_dom_snapshot with listTabs: true lists the open tabs with their chrome.tabs id.",
    });
  }

  if (!isChromiumFamily(browser)) {
    return refuse({
      status: "unsupported-browser",
      error: {
        code: "E_UNSUPPORTED_BROWSER",
        name: "Unsupported",
        message: `Replaying contextMenus.onClicked rides the browser's debug port (CDP), which ${browser} does not expose, and the dev session's control channel carries no context menu verb, so nothing was done.`,
      },
      hint: 'Run the session in a Chromium browser (extension_dev with browser: "chrome") for this replay, or pick the item by hand in the dev browser and read extension_logs.',
    });
  }

  const resolved = await resolveCdpPort(args.projectPath, browser, { timeoutMs: args.timeout });

  if (!resolved) {
    return noSessionEnvelope({
      command: COMMAND,
      projectPath: args.projectPath,
      browser,
      name: "NoSession",
      need: "so there is no service worker to replay the menu click in",
      dev: {
        message: `No live ${browser} session with a debug port (CDP) for this project, so there is no service worker to replay the menu click in. Start extension_dev and extension_wait for ready. ${CDP_PORT_MISSING_HINT}`,
      },
    });
  }

  const outcome = await replayContextMenuClick(resolved.port, { projectPath: args.projectPath, browser }, args.menuItemId, args.tab ?? null, args.timeout);

  return outcomeAnswer(args, browser, outcome);
}
