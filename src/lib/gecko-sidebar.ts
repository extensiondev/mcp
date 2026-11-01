// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { resolveBridgeBaseUrl } from "./bridge-tabs";
import { geckoAddonId } from "./gecko-addon";
import { resolveRdpPort } from "./cdp-port";
import { envelope } from "./envelope";
import { rdpEvaluateInParentProcess } from "./rdp";

export type GeckoAddonIdentity = { addonId: string | null; host: string | null };

export async function geckoAddonIdentity(projectPath: string, browser: string, timeout?: number): Promise<GeckoAddonIdentity | null> {
  const addonId = geckoAddonId(projectPath, browser);
  const base = addonId ? null : await resolveBridgeBaseUrl(projectPath, browser, timeout);
  const host = base ? base.replace(/^[a-z-]+:\/\//, "").replace(/\/.*$/, "") : null;

  return addonId || host ? { addonId, host } : null;
}

export function addonPolicyExpression(identity: GeckoAddonIdentity): string {
  return identity.addonId
    ? `WebExtensionPolicy.getByID(${JSON.stringify(identity.addonId)})`
    : `WebExtensionPolicy.getByHostname(${JSON.stringify(identity.host)})`;
}

export const ADDON_UNNAMED =
  "the add-on could not be named to the browser: the built manifest sets no gecko id and its moz-extension:// host could not be read";

export type GeckoSidebarPanel = {
  open: boolean;
  browsingContextId: number | null;
  url: string | null;
  width: number | null;
  height: number | null;
};

export function sidebarPanelExpression(identity: GeckoAddonIdentity, open: boolean): string {
  return `(async () => {
  const policy = ${addonPolicyExpression(identity)};
  const extension = policy && policy.extension;
  if (!extension) return { outcome: "no-extension" };
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const lookup = ExtensionParent.apiManager.global.sidebarActionFor;
  const action = typeof lookup === "function" ? lookup(extension) : null;
  if (!action || typeof action.isOpen !== "function") return { outcome: "no-sidebar-action" };
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  if (!win || !win.SidebarController) return { outcome: "no-window" };
  if (${open} && !action.isOpen(win)) action.open(win);
  const panelOf = () => {
    const host = win.SidebarController.browser;
    const doc = host && host.contentDocument;
    return doc ? doc.getElementById("webext-panels-browser") : null;
  };
  const urlOf = (panel) => (panel && panel.currentURI ? panel.currentURI.spec : null);
  const deadline = Date.now() + 5000;
  let panel = panelOf();
  while (action.isOpen(win) && !String(urlOf(panel) || "").startsWith("moz-extension:") && Date.now() < deadline) {
    await new Promise((resolve) => win.setTimeout(resolve, 100));
    panel = panelOf();
  }
  const rect = panel ? panel.getBoundingClientRect() : null;
  return {
    outcome: "read",
    open: action.isOpen(win),
    browsingContextId: panel && panel.browsingContext ? panel.browsingContext.id : null,
    url: urlOf(panel),
    width: rect ? Math.round(rect.width) : null,
    height: rect ? Math.round(rect.height) : null,
  };
})()`;
}

const OUTCOME_REASONS: Record<string, string> = {
  "no-extension": "the browser has no running add-on by that id",
  "no-sidebar-action": "the browser holds no sidebar_action for this add-on",
  "no-window": "the browser has no window with a sidebar",
};

export async function geckoSidebarPanel(
  projectPath: string,
  browser: string,
  options: { open: boolean; timeout?: number },
): Promise<{ panel: GeckoSidebarPanel } | { reason: string }> {
  const resolved = await resolveRdpPort(projectPath, browser, { waitMs: 3_000, graceMs: 1_000 });
  if (!resolved) return { reason: "the session's ready contract records no debugger (RDP) port" };

  const identity = await geckoAddonIdentity(projectPath, browser, options.timeout);
  if (!identity) return { reason: ADDON_UNNAMED };

  try {
    const outcome = await rdpEvaluateInParentProcess(resolved.port, {
      expression: sidebarPanelExpression(identity, options.open),
      timeoutMs: Math.max(options.timeout ?? 10_000, 8_000),
    });

    if (!outcome.ok) return { reason: `the browser refused it (${outcome.name}: ${outcome.message})` };

    const value = (outcome.value ?? {}) as Record<string, unknown>;

    if (value.outcome !== "read") {
      return { reason: OUTCOME_REASONS[String(value.outcome)] ?? `the browser answered ${JSON.stringify(outcome.value)}` };
    }

    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

    return {
      panel: {
        open: value.open === true,
        browsingContextId: num(value.browsingContextId),
        url: typeof value.url === "string" ? value.url : null,
        width: num(value.width),
        height: num(value.height),
      },
    };
  } catch (err) {
    return { reason: `the debugger port ${resolved.port} did not answer (${err instanceof Error ? err.message : String(err)})` };
  }
}

export function sidebarOpenedAnswer(tool: string, document: string, panel: GeckoSidebarPanel): string {
  return envelope({
    ok: true,
    command: tool,
    status: "opened",
    value: {
      surface: "sidebar",
      document,
      via: "browser-sidebar-controller",
      ...(panel.url ? { url: panel.url } : {}),
      ...(panel.width != null && panel.height != null ? { panel: { width: panel.width, height: panel.height } } : {}),
    },
    warnings: [
      "Firefox opens a sidebar_action panel from an extension only inside a user gesture, so the server opened the real panel through the browser's own sidebar controller in Firefox's parent process over the debugger protocol (the path View > Sidebar takes). The panel is the real one; the extension's own open path (a sidebarAction.open or toggle call in a listener) was not exercised.",
    ],
    hint: "Read the panel with extension_dom_snapshot context: 'sidebar', run code in it with extension_eval context: 'sidebar', or capture it with extension_screenshot context: 'sidebar'.",
  });
}
