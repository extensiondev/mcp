// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { resolveBridgeBaseUrl } from "./bridge-tabs";
import { geckoAddonId } from "./gecko-addon";
import { resolveRdpPort } from "./cdp-port";
import { envelope } from "./envelope";
import { manifestCandidates } from "./project-manifest";
import { rdpEvaluateInParentProcess } from "./rdp";

export type ToolbarButton = {
  key: "action" | "browser_action" | "page_action";
  popup: string | null;
};

const TOOLBAR_KEYS = ["action", "browser_action", "page_action"] as const;

export function declaredToolbarButton(projectPath: string, browser: string): ToolbarButton | null {
  for (const file of manifestCandidates(projectPath, browser)) {
    let manifest: Record<string, any>;

    try {
      manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }

    for (const key of TOOLBAR_KEYS) {
      const entry = manifest[key];
      if (!entry || typeof entry !== "object") continue;

      const popup = typeof entry.default_popup === "string" && entry.default_popup ? entry.default_popup : null;

      return { key, popup };
    }

    return null;
  }

  return null;
}

function buttonLabel(button: ToolbarButton): string {
  return button.key === "page_action"
    ? "address-bar button (page_action)"
    : `toolbar button (${button.key})`;
}

function toolbarClickExpression(
  button: ToolbarButton,
  identity: { addonId: string | null; host: string | null },
): string {
  const lookup = button.key === "page_action" ? "pageActionFor" : "browserActionFor";
  const policy = identity.addonId
    ? `WebExtensionPolicy.getByID(${JSON.stringify(identity.addonId)})`
    : `WebExtensionPolicy.getByHostname(${JSON.stringify(identity.host)})`;

  return `(() => {
  const policy = ${policy};
  const extension = policy && policy.extension;
  if (!extension) return { outcome: "no-extension" };
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const lookup = ExtensionParent.apiManager.global.${lookup};
  const action = typeof lookup === "function" ? lookup(extension) : null;
  if (!action || typeof action.triggerAction !== "function") return { outcome: "no-action-api" };
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  if (!win) return { outcome: "no-window" };
  action.triggerAction(win);
  return { outcome: "triggered" };
})()`;
}

const OUTCOME_REASONS: Record<string, string> = {
  "no-extension": "the browser has no running add-on by that id",
  "no-action-api": "the browser holds no toolbar action for this add-on",
  "no-window": "the browser has no window for the button to sit in",
};

async function replayToolbarClick(
  projectPath: string,
  browser: string,
  button: ToolbarButton,
  timeout?: number,
): Promise<string | null> {
  const resolved = await resolveRdpPort(projectPath, browser, { waitMs: 3_000, graceMs: 1_000 });
  if (!resolved) return "the session's ready contract records no debugger (RDP) port";

  const addonId = geckoAddonId(projectPath, browser);
  const base = addonId ? null : await resolveBridgeBaseUrl(projectPath, browser, timeout);
  const host = base ? base.replace(/^[a-z-]+:\/\//, "").replace(/\/.*$/, "") : null;

  if (!addonId && !host) {
    return "the add-on could not be named to the browser: the built manifest sets no gecko id and its moz-extension:// host could not be read";
  }

  try {
    const outcome = await rdpEvaluateInParentProcess(resolved.port, {
      expression: toolbarClickExpression(button, { addonId, host }),
      timeoutMs: timeout ?? 10_000,
    });

    if (!outcome.ok) return `the browser refused it (${outcome.name}: ${outcome.message})`;

    const said = (outcome.value as { outcome?: unknown } | null)?.outcome;

    return said === "triggered"
      ? null
      : (OUTCOME_REASONS[String(said)] ?? `the browser answered ${JSON.stringify(outcome.value)}`);
  } catch (err) {
    return `the debugger port ${resolved.port} did not answer (${err instanceof Error ? err.message : String(err)})`;
  }
}

export async function clickGeckoToolbarButton(
  tool: string,
  projectPath: string,
  browser: string,
  button: ToolbarButton,
  engineFrame: Record<string, any>,
  declared: string[],
  timeout?: number,
): Promise<string> {
  const said = String(engineFrame.error?.message ?? "no answer").replace(/\s+/g, " ").trim();
  const label = buttonLabel(button);
  const why = await replayToolbarClick(projectPath, browser, button, timeout);

  if (why === null) {
    const shortcut = button.key === "page_action" ? "_execute_page_action" : `_execute_${button.key}`;

    return envelope({
      ok: true,
      command: tool,
      status: "triggered",
      value: { triggered: "onClicked", manifestKey: button.key, via: "browser-toolbar-action" },
      warnings: [
        `Firefox gives extensions no API to replay a click on the ${label}, and the engine's own replay refused (${said}), so the server ran the browser's toolbar action for this add-on (the path the ${shortcut} shortcut takes) in Firefox's parent process over the debugger protocol. Firefox handles it as a click on the button in the front window, with that window's selected tab. Whether a listener ran, and what it did, is not read here.`,
      ],
      hint: "Read what the listener did with extension_logs, or the state it changes (extension_storage, or extension_dom_snapshot with listTabs: true).",
    });
  }

  return envelope({
    ok: false,
    command: tool,
    status: "action-not-replayed",
    error: {
      code: "E_ACTION_NOT_REPLAYED",
      name: "ActionNotReplayed",
      message: `This extension declares a ${label} with no popup, so clicking it runs its onClicked listener. Firefox gives extensions no API to replay that click, the engine's own replay refused (${said}), and the server's route through the browser's toolbar action did not run: ${why}.`,
    },
    value: { manifestKey: button.key },
    hint: `${declared.includes("sidebar") ? 'extension_open with surface: "sidebar" reaches the sidebar panel, and ' : ""}extension_eval with context: "background" runs the code the listener calls.`,
  });
}
