// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { CDPClient } from "./cdp";
import { resolveCdpPort } from "./cdp-port";
import { sessionGuestIdentity } from "./extension-identity";
import { isSafariTarget } from "./safari-dev-options";

export const DEVELOPER_MODE_REASON = "unsupportedDeveloperExtension";

const EXTENSIONS_PAGE = "chrome://extensions";

const SYSTEM_CHROMIUM: Record<string, string[]> = {
  darwin: ["/Applications/Chromium.app/Contents/MacOS/Chromium"],
  linux: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
  win32: [],
};

export interface UnpackedRefusal {
  extensionId: string;
  state: string;
  disableReasons: string[];
  browserVersion: string | null;
  developerModeTurnedOn: boolean;
  stateAfter: string | null;
}

export interface UnpackedWayOut {
  sentence: string;
  args: Record<string, unknown>;
}

function readInfo(id: string): string {
  return `new Promise((resolve) => chrome.developerPrivate.getExtensionInfo(${JSON.stringify(id)}, (info) => resolve(info ? { state: info.state, reasons: Object.keys(info.disableReasons || {}).filter((key) => info.disableReasons[key]) } : null)))`;
}

const TURN_ON_DEVELOPER_MODE =
  "new Promise((resolve) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => resolve(!chrome.runtime.lastError)))";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readUnpackedRefusal(
  projectPath: string,
  browser: string,
  options: { timeoutMs?: number; settleMs?: number } = {},
): Promise<UnpackedRefusal | null> {
  if (isSafariTarget(browser)) return null;

  const ids = sessionGuestIdentity(projectPath, browser).expectedIds;
  if (!ids.length) return null;

  const resolved = await resolveCdpPort(projectPath, browser, { waitMs: 0 }).catch(() => null);
  if (!resolved) return null;

  const timeoutMs = options.timeoutMs ?? 2_000;
  const client = new CDPClient();
  let targetId = "";

  try {
    const browserVersion = await CDPClient.discoverBrowserVersion(resolved.port);
    await client.connect(await CDPClient.discoverBrowserWsUrl(resolved.port));

    const created = (await client.sendCommand("Target.createTarget", { url: EXTENSIONS_PAGE, background: true }, undefined, timeoutMs)) as { targetId?: string } | undefined;
    targetId = created?.targetId ?? "";
    if (!targetId) return null;

    const sessionId = await client.attachToTarget(targetId);
    if (!sessionId) return null;

    for (const id of ids) {
      const info = (await client.evaluateAwaited(sessionId, readInfo(id), timeoutMs).catch(() => null)) as { state?: unknown; reasons?: unknown } | null;
      const reasons = Array.isArray(info?.reasons) ? info.reasons.map(String) : [];
      if (!reasons.includes(DEVELOPER_MODE_REASON)) continue;

      const turnedOn = (await client.evaluateAwaited(sessionId, TURN_ON_DEVELOPER_MODE, timeoutMs).catch(() => false)) === true;
      if (turnedOn) await sleep(options.settleMs ?? 500);

      const after = turnedOn ? ((await client.evaluateAwaited(sessionId, readInfo(id), timeoutMs).catch(() => null)) as { state?: unknown } | null) : null;

      return {
        extensionId: id,
        state: String(info?.state ?? "DISABLED"),
        disableReasons: reasons,
        browserVersion,
        developerModeTurnedOn: turnedOn,
        stateAfter: typeof after?.state === "string" ? after.state : null,
      };
    }

    return null;
  } catch {
    return null;
  } finally {
    if (targetId) await client.sendCommand("Target.closeTarget", { targetId }, undefined, timeoutMs).catch(() => undefined);

    client.disconnect();
  }
}

export function unpackedRefusalLifted(refusal: UnpackedRefusal): boolean {
  return refusal.developerModeTurnedOn && refusal.stateAfter === "ENABLED";
}

export function systemChromiumBinary(platform: string = process.platform, exists: (file: string) => boolean = fs.existsSync): string | null {
  return (SYSTEM_CHROMIUM[platform] ?? []).find((file) => exists(file)) ?? null;
}

export function unpackedRefusalWayOut(projectPath: string, browser: string, chromiumBinary: string | null = systemChromiumBinary()): UnpackedWayOut {
  if (chromiumBinary) {
    return {
      sentence: `Relaunch on Chromium under the same target, which keeps dist/${browser} and files captures into the chrome set: call extension_dev with replace: true and chromiumBinary: "${chromiumBinary}".`,
      args: { projectPath, browser, replace: true, chromiumBinary },
    };
  }

  return {
    sentence: 'Relaunch on Chromium, whose captures file into the chrome set: call extension_dev with browser: "chromium" and replace: true.',
    args: { projectPath, browser: "chromium", replace: true },
  };
}

export function unpackedRefusalSays(refusal: UnpackedRefusal): string {
  const name = refusal.browserVersion ? refusal.browserVersion.replace("/", " ") : "This browser";
  const read = `${name} turned this unpacked extension off: chrome://extensions reads ${refusal.extensionId} as ${refusal.state} with disableReasons.${DEVELOPER_MODE_REASON}, the reason Chrome gives an unpacked extension while developer mode is off.`;

  if (unpackedRefusalLifted(refusal)) {
    return `${read} This server turned developer mode on in the session's profile and Chrome enabled the extension again, so its background can now connect.`;
  }

  return `${read} Branded Google Chrome ignores --load-extension and keeps an unpacked extension on only while it was loaded over the debug port or developer mode is on; a reload drops the first, and ${refusal.developerModeTurnedOn ? "turning developer mode on here did not enable it again" : "this server could not turn developer mode on"}. A fresh profile does not change that.`;
}
