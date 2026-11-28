// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { BACKGROUND_TARGET_TYPES, evaluateOnExtensionPage, findExtensionWorkerTargets, wakeExtensionWorker, type ExtensionPageEval, type WorkerWake } from "./cdp-extension-page";
import { cdpAttachDriver, debugPortOf, unpackedExtensionId } from "./guided-attach";
import { guidedProcess, type GuidedProcess } from "./guided-window-end";

const RELOAD_EXPRESSION = "setTimeout(() => chrome.runtime.reload(), 50), true";

const VERSION_EXPRESSION = "globalThis.chrome?.runtime?.getManifest?.().version ?? null";

export type ToolsReload = { reloaded: true } | { reloaded: false; reason: string };

export interface ToolsReloadDriver {
  port(profileDir: string): number | null;
  workers(port: number, extensionId: string): Promise<Array<{ targetId: string; type: string }>>;
  wake(port: number, extensionId: string): Promise<WorkerWake>;
  evaluate(port: number, targetId: string, expression: string): Promise<ExtensionPageEval>;
  openPage(port: number, url: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export function toolsReloadDriver(proc: GuidedProcess = guidedProcess): ToolsReloadDriver {
  return {
    port: (profileDir) => debugPortOf(profileDir, proc),
    workers: (port, extensionId) => findExtensionWorkerTargets(port, extensionId),
    wake: (port, extensionId) => wakeExtensionWorker(port, extensionId),
    evaluate: (port, targetId, expression) => evaluateOnExtensionPage(port, targetId, expression, 3_000),
    openPage: async (port, url) => {
      const browserUrl = await cdpAttachDriver.browser?.(port);
      if (!browserUrl) return false;

      const browser = await cdpAttachDriver.open(browserUrl);

      try {
        await browser.send("Target.createTarget", { url });

        return true;
      } finally {
        browser.close();
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

async function background(driver: ToolsReloadDriver, port: number, extensionId: string): Promise<{ targetId: string } | { reason: string }> {
  const listed = (await driver.workers(port, extensionId)).find((target) => BACKGROUND_TARGET_TYPES.has(target.type));
  if (listed) return listed;

  const wake = await driver.wake(port, extensionId);
  if (!wake.woken) return { reason: `its extension.dev tools background is not running and waking it failed: ${wake.reason}` };

  return wake.targets.find((target) => BACKGROUND_TARGET_TYPES.has(target.type)) ?? { reason: "its extension.dev tools background did not start" };
}

/* @invariant A NEWER EXTENSION.DEV TOOLS IS SWAPPED INTO THE OPEN GUIDED
 * WINDOW WITHOUT CLOSING IT (MCP ledger 1312). App Store Connect keeps its
 * sign-in only for the browser session, so a restart signs the person out
 * of Apple. The copy on disk already holds the new build, so the running
 * browser reloads its own unpacked extension.dev tools over this profile's
 * debug port (chrome.runtime.reload in the tools background, woken first
 * when asleep), and the swap counts only once a tools background answers
 * with the new build's version; anything less is reported with why.
 */
export async function reloadGuidedTools(args: { profileDir: string; extensionDir: string; build: string; driver?: ToolsReloadDriver; waitMs?: number }): Promise<ToolsReload> {
  const driver = args.driver ?? toolsReloadDriver();
  const port = driver.port(args.profileDir);
  if (!port) return { reloaded: false, reason: "the window has no debug port this MCP can reach" };

  const extensionId = unpackedExtensionId(args.extensionDir);

  try {
    const target = await background(driver, port, extensionId);
    if ("reason" in target) return { reloaded: false, reason: target.reason };

    const ran = await driver.evaluate(port, target.targetId, RELOAD_EXPRESSION);
    if (!ran.ok) return { reloaded: false, reason: `the reload did not run: ${ran.message}` };

    let seen = "";

    for (let waited = 0; waited < (args.waitMs ?? 8_000); waited += 250) {
      await driver.sleep(250);

      const next = await background(driver, port, extensionId);
      if ("reason" in next) continue;

      const read = await driver.evaluate(port, next.targetId, VERSION_EXPRESSION);
      seen = read.ok && typeof read.value === "string" ? read.value : seen;

      if (seen === args.build) return { reloaded: true };
    }

    return { reloaded: false, reason: seen ? `after the reload the tools still answered version ${seen}, not ${args.build}` : "no tools background answered after the reload" };
  } catch (err) {
    return { reloaded: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
