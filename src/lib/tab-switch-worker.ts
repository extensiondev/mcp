// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CDPClient } from "./cdp";
import { BACKGROUND_TARGET_TYPES, wakeExtensionWorker } from "./cdp-extension-page";
import { sessionGuestIdentity } from "./extension-identity";

const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})\//i;

export async function windowOf(port: number, targetId: string): Promise<number | null> {
  return (await windowStateOf(port, targetId)).windowId;
}

export async function windowStateOf(port: number, targetId: string): Promise<{ windowId: number | null; windowState: string | null }> {
  const cdp = new CDPClient();

  try {
    await cdp.connect(await CDPClient.discoverBrowserWsUrl(port));
    const found = (await cdp.sendCommand("Browser.getWindowForTarget", { targetId }, undefined, 3_000)) as
      | { windowId?: unknown; bounds?: { windowState?: unknown } }
      | undefined;

    return {
      windowId: typeof found?.windowId === "number" ? found.windowId : null,
      windowState: typeof found?.bounds?.windowState === "string" ? found.bounds.windowState : null,
    };
  } catch {
    return { windowId: null, windowState: null };
  } finally {
    cdp.disconnect();
  }
}

export async function tabsWorker(port: number, projectPath: string, browser: string): Promise<{ targetId: string } | { reason: string }> {
  const found = await tabsWorkers(port, projectPath, browser);

  return "reason" in found ? found : { targetId: found.workers[0]!.targetId };
}

export async function tabsWorkers(port: number, projectPath: string, browser: string): Promise<{ workers: Array<{ targetId: string; url: string }> } | { reason: string }> {
  const identity = sessionGuestIdentity(projectPath, browser);
  const preferred = [...identity.expectedIds, ...identity.companionIds];
  let listed: Array<{ id: string; type: string; url: string }>;

  try {
    listed = (await CDPClient.discoverTargets(port)).map((t) => ({ id: String(t.id), type: String(t.type), url: String(t.url ?? "") }));
  } catch (error) {
    return { reason: `the browser's target list could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }

  const workers = listed.filter((t) => BACKGROUND_TARGET_TYPES.has(t.type) && EXTENSION_ORIGIN.test(t.url));

  const rank = (url: string): number => {
    const id = (EXTENSION_ORIGIN.exec(url)?.[1] ?? "").toLowerCase();
    const at = preferred.indexOf(id);

    return at === -1 ? preferred.length : at;
  };

  const ranked = workers.sort((a, b) => rank(a.url) - rank(b.url)).map((t) => ({ targetId: t.id, url: t.url }));
  if (ranked.length) return { workers: ranked };

  for (const id of identity.expectedIds) {
    const wake = await wakeExtensionWorker(port, id);
    const woken = wake.woken ? wake.targets.find((t) => BACKGROUND_TARGET_TYPES.has(t.type)) : undefined;
    if (woken) return { workers: [{ targetId: woken.targetId, url: `chrome-extension://${id}/` }] };
  }

  return { reason: "no extension background is running in the browser to switch tabs from" };
}
