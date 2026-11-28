// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { cdpAttachDriver, debugPortOf, unpackedExtensionId } from "./guided-attach";
import { guidedProcess, type GuidedProcess } from "./guided-window-end";
import { isRow, text } from "./row";

export const EXTENSIONS_PAGE = "chrome://extensions/";

export type ToolsReload = { reloaded: true } | { reloaded: false; reason: string };

export interface ToolsReloadDriver {
  port(profileDir: string): number | null;
  onExtensionsPage(port: number, expression: string): Promise<unknown>;
  openPage(port: number, url: string): Promise<boolean>;
}

async function browserSession(port: number) {
  const browserUrl = await cdpAttachDriver.browser?.(port);
  if (!browserUrl) throw new Error(`nothing answers the browser endpoint on debug port ${port}`);

  return cdpAttachDriver.open(browserUrl);
}

export function toolsReloadDriver(proc: GuidedProcess = guidedProcess): ToolsReloadDriver {
  return {
    port: (profileDir) => debugPortOf(profileDir, proc),
    onExtensionsPage: async (port, expression) => {
      const browser = await browserSession(port);
      let targetId = "";

      try {
        const created = (await browser.send("Target.createTarget", { url: EXTENSIONS_PAGE, background: true })) as { targetId?: string };
        targetId = text(created?.targetId);

        let page: { webSocketDebuggerUrl: string } | undefined;

        for (let tries = 0; !page && tries < 20; tries += 1) {
          await cdpAttachDriver.sleep(250);
          page = (await cdpAttachDriver.targets(port)).find((target) => target.type === "page" && target.url.startsWith(EXTENSIONS_PAGE) && target.webSocketDebuggerUrl.endsWith(`/${targetId}`));
        }

        if (!page) throw new Error("the browser's extensions page did not open");

        const session = await cdpAttachDriver.open(page.webSocketDebuggerUrl);

        try {
          const answer = (await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } };
          if (answer?.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description?.split("\n")[0] ?? "the extensions page threw");

          return answer?.result?.value ?? null;
        } finally {
          session.close();
        }
      } finally {
        if (targetId) await browser.send("Target.closeTarget", { targetId }).catch(() => undefined);

        browser.close();
      }
    },
    openPage: async (port, url) => {
      const browser = await browserSession(port);

      try {
        await browser.send("Target.createTarget", { url });

        return true;
      } finally {
        browser.close();
      }
    },
  };
}

export function reloadExpression(extensionId: string, build: string, waitMs: number): string {
  return `(async () => {
  const id = ${JSON.stringify(extensionId)};
  const dev = globalThis.chrome?.developerPrivate;
  if (!dev) return { error: "the extensions page has no developer API" };
  await dev.updateProfileConfiguration({ inDeveloperMode: true });
  const first = await dev.getExtensionInfo(id);
  if (first.state !== "ENABLED") await chrome.management.setEnabled(id, true);
  await dev.reload(id, { failQuietly: true });
  let info = first;
  for (const until = Date.now() + ${waitMs}; Date.now() < until; await new Promise((done) => setTimeout(done, 250))) {
    info = await dev.getExtensionInfo(id);
    if (info.state === "ENABLED" && info.version === ${JSON.stringify(build)}) break;
  }
  return { state: info.state, version: info.version, reasons: Object.keys(info.disableReasons || {}).filter((key) => info.disableReasons[key]) };
})()`;
}

/* @invariant A NEWER EXTENSION.DEV TOOLS IS SWAPPED INTO THE OPEN GUIDED
 * WINDOW WITHOUT CLOSING IT (MCP ledger 1312). App Store Connect keeps its
 * sign-in only for the browser session, so a restart signs the person out
 * of Apple. The copy on disk already holds the new build, so the running
 * browser reloads its unpacked extension.dev tools the way its own
 * extensions page does, from a background tab of that page opened over this
 * profile's debug port. Chromium disables a command-line extension that
 * reloads itself while developer mode is off (DISABLE_UNSUPPORTED_DEVELOPER_
 * EXTENSION), so that dedicated profile has developer mode turned on first.
 * The swap counts only once the browser lists the tools enabled at the new
 * build's version; anything less is reported with why.
 */
export async function reloadGuidedTools(args: { profileDir: string; extensionDir: string; build: string; driver?: ToolsReloadDriver; waitMs?: number }): Promise<ToolsReload> {
  const driver = args.driver ?? toolsReloadDriver();
  const port = driver.port(args.profileDir);
  if (!port) return { reloaded: false, reason: "the window has no debug port this MCP can reach" };

  try {
    const value = await driver.onExtensionsPage(port, reloadExpression(unpackedExtensionId(args.extensionDir), args.build, args.waitMs ?? 8_000));
    if (!isRow(value)) return { reloaded: false, reason: "the extensions page gave no answer" };
    if (value.error) return { reloaded: false, reason: text(value.error) };
    if (value.state === "ENABLED" && value.version === args.build) return { reloaded: true };

    const reasons = Array.isArray(value.reasons) && value.reasons.length ? ` (${value.reasons.map(text).join(", ")})` : "";

    return { reloaded: false, reason: `after the reload the browser lists the tools ${text(value.state).toLowerCase() || "in no state"} at version ${text(value.version) || "unknown"}${reasons}, not enabled at ${args.build}` };
  } catch (err) {
    return { reloaded: false, reason: `the reload did not run: ${err instanceof Error ? err.message : String(err)}` };
  }
}
