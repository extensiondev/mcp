// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CDPClient } from "./cdp";
import { resolveCdpPort } from "./cdp-port";
import { CARRIER_EXTENSION_ID } from "./carrier";

const ENGINE_COMPANION_IDS = new Set<string>([
  "kgdaecdpfkikjncaalnmmnjjfpofkcbl",
  CARRIER_EXTENSION_ID,
]);

const EXTENSION_URL = /^chrome-extension:\/\/([a-p]{32})\//i;

export type GuestTarget = { id: string; type: string; url: string };

export type GuestLoadCheck = {
  checked: boolean;
  loaded: boolean;
  guestTargets: GuestTarget[];
  guestIds: string[];
  cdpPort?: number;
  reason: string;
};

export async function verifyGuestLoaded(
  projectPath: string,
  browser: string,
  options?: { waitMs?: number; timeoutMs?: number },
): Promise<GuestLoadCheck> {
  let cdpPort: number | undefined;
  try {
    const resolved = await resolveCdpPort(projectPath, browser, {
      waitMs: options?.waitMs ?? 0,
    });
    if (!resolved) {
      return {
        checked: false,
        loaded: false,
        guestTargets: [],
        guestIds: [],
        reason:
          "No CDP port in the session's ready contract, so the browser's target list could not be queried (a headless Chromium session still exposes one; a gecko/Firefox session does not).",
      };
    }
    cdpPort = resolved.port;
    const timeoutMs = options?.timeoutMs ?? 3000;
    const targets = await Promise.race([
      CDPClient.discoverTargets(cdpPort),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`CDP /json timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);

    const guestTargets: GuestTarget[] = [];
    for (const t of targets) {
      const match = EXTENSION_URL.exec(String(t.url ?? ""));
      if (!match) continue;
      const id = match[1].toLowerCase();
      if (ENGINE_COMPANION_IDS.has(id)) continue;
      guestTargets.push({ id, type: String(t.type), url: String(t.url) });
    }
    const guestIds = [...new Set(guestTargets.map((t) => t.id))];
    return {
      checked: true,
      loaded: guestTargets.length > 0,
      guestTargets,
      guestIds,
      cdpPort,
      reason:
        guestTargets.length > 0
          ? `The browser lists ${guestIds.length} extension target${guestIds.length === 1 ? "" : "s"} that are not the engine companion (${guestIds.join(", ")}), so the guest is loaded.`
          : "The browser's target list has no chrome-extension:// target other than the engine's devtools companion. On Chrome this is the signature of a silently rejected --load-extension (extension.js BUGS_TO_FIX §83): the CLI and ready.json cannot see it.",
    };
  } catch (err) {
    return {
      checked: false,
      loaded: false,
      guestTargets: [],
      guestIds: [],
      cdpPort,
      reason: `Could not query the browser's target list${
        cdpPort ? ` on CDP port ${cdpPort}` : ""
      }: ${(err as Error)?.message ?? String(err)}.`,
    };
  }
}
