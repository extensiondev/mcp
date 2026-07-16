import { CDPClient } from "../lib/cdp";
import { resolveCdpPort, CDP_PORT_MISSING_HINT } from "../lib/cdp-port";
import { resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_list_extensions",
  description:
    "List the extensions with a live context in the running dev browser via Chrome DevTools Protocol. Returns each extension's id, name, version, and live contexts (service worker, page). Identity is read read-only via the Extensions domain — other extensions' contexts are never attached to or evaluated in. A dormant MV3 service worker with no open page may be absent until it wakes. Chromium only (Firefox uses RDP, not yet supported). Requires an active dev or start session.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description:
          "Path to the extension project root (must have an active dev session)",
      },
      browser: {
        type: "string",
        description:
          "Browser session to target. Defaults to the active dev session's browser for this project.",
      },
    },
    required: ["projectPath"],
  },
};

interface ExtensionEntry {
  id: string;
  name?: string;
  version?: string;
  contexts: Array<{ type: string; url: string }>;
  source: "extensions-domain" | "target-only";
}

export async function handler(args: {
  projectPath: string;
  browser?: string;
}): Promise<string> {
  const { browser } = resolveSessionBrowser(
    args.projectPath,
    args.browser,
    "chrome",
  );
  const isChromium = ["chrome", "chromium", "edge", "chromium-based"].includes(
    browser,
  );

  if (!isChromium) {
    return JSON.stringify({
      error: `Listing extensions for ${browser} uses RDP (Remote Debug Protocol). Currently only Chromium CDP is supported.`,
      hint: 'Pass browser: "chrome" (against a Chromium-family dev session).',
    });
  }

  const resolved = await resolveCdpPort(args.projectPath, browser);
  if (!resolved) {
    return JSON.stringify({
      error:
        "No active dev session found. Cannot connect to Chrome DevTools Protocol.",
      hint: `Start a dev session first with extension_dev, then use extension_wait to confirm it is ready. ${CDP_PORT_MISSING_HINT}`,
    });
  }
  const cdpPort = resolved.port;

  const cdp = new CDPClient();
  try {
    // The contract's port is stamped post-launch (resolveCdpPort waits for
    // it), but the socket itself can still be a beat behind — give the dial
    // a short grace window instead of bouncing the agent into retry lore.
    let targets: Awaited<ReturnType<CDPClient["getTargets"]>> | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const browserWsUrl = await CDPClient.discoverBrowserWsUrl(cdpPort);
        await cdp.connect(browserWsUrl);
        targets = await cdp.getTargets();
        break;
      } catch (error) {
        lastError = error;
        cdp.disconnect();
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }
    }
    if (!targets) throw lastError;

    // Group every chrome-extension:// target by its extension id.
    const byId = new Map<string, Array<{ type: string; url: string }>>();
    for (const t of targets) {
      const url = String(t.url ?? "");
      if (!url.startsWith("chrome-extension://")) continue;
      const id = url.slice("chrome-extension://".length).split("/")[0];
      if (!id) continue;
      const list = byId.get(id) ?? [];
      list.push({ type: String(t.type ?? ""), url });
      byId.set(id, list);
    }

    const extensions: ExtensionEntry[] = [];
    for (const [id, ctxTargets] of byId) {
      const entry: ExtensionEntry = {
        id,
        contexts: ctxTargets.map((c) => ({ type: c.type, url: c.url })),
        source: "target-only",
      };

      // Read identity via the browser-level Extensions domain — no attach, no
      // eval into another extension's context (so we never wake or disturb a
      // third-party service worker just to list it).
      try {
        const info = (await cdp.sendCommand("Extensions.getExtensionInfo", {
          extensionId: id,
        })) as { extensionInfo?: { name?: string; version?: string } };
        if (info?.extensionInfo) {
          entry.name = info.extensionInfo.name;
          entry.version = info.extensionInfo.version;
          entry.source = "extensions-domain";
        }
      } catch {
        // Extensions domain unavailable (older Chromium) — keep target-only.
      }

      extensions.push(entry);
    }

    extensions.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));

    return JSON.stringify({
      cdpPort,
      browser,
      count: extensions.length,
      extensions,
      note:
        "Lists extensions that currently have at least one live context (service worker or open page). An MV3 service worker that has gone dormant with no open page may be absent until it wakes. Identity is read read-only via the Extensions domain; other extensions' contexts are never attached to or evaluated in.",
    });
  } catch (error) {
    return JSON.stringify({
      error: `Failed to list extensions: ${(error as Error).message}`,
    });
  } finally {
    cdp.disconnect();
  }
}

