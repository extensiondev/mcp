// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CDPClient } from "./cdp";
import { resolveCdpPort } from "./cdp-port";
import { sessionGuestIdentity } from "./extension-identity";

const EXTENSION_URL = /^chrome-extension:\/\/([a-p]{32})\//i;

export function isEngineCompanionUrl(url: string, projectPath?: string, browser?: string): boolean {
  const match = EXTENSION_URL.exec(String(url ?? ""));
  if (!match) return false;
  const id = match[1]!.toLowerCase();
  const companions = projectPath && browser
    ? sessionGuestIdentity(projectPath, browser).companionIds
    : sessionGuestIdentity("", "chrome").companionIds;
  return companions.has(id);
}

export type GuestTarget = { id: string; type: string; url: string };

export type GuestLoadCheck = {
  checked: boolean;
  loaded: boolean;
  guestTargets: GuestTarget[];
  guestIds: string[];
  otherExtensionIds?: string[];
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

    const identity = sessionGuestIdentity(projectPath, browser);
    if (identity.expectedIds.length === 0) {
      return {
        checked: false,
        loaded: false,
        guestTargets: [],
        guestIds: [],
        cdpPort,
        reason:
          "The session's ready contract names no extensionId and no distPath, so the browser's target list cannot be matched to this project's extension.",
      };
    }
    const guestTargets: GuestTarget[] = [];
    const otherIds = new Set<string>();
    for (const t of targets) {
      const match = EXTENSION_URL.exec(String(t.url ?? ""));
      if (!match) continue;
      const id = match[1]!.toLowerCase();
      if (identity.companionIds.has(id)) continue;
      if (identity.expectedIds.includes(id)) {
        guestTargets.push({ id, type: String(t.type), url: String(t.url) });
      } else {
        otherIds.add(id);
      }
    }
    const guestIds = [...new Set(guestTargets.map((t) => t.id))];
    const others = [...otherIds];
    return {
      checked: true,
      loaded: guestTargets.length > 0,
      guestTargets,
      guestIds,
      otherExtensionIds: others,
      cdpPort,
      reason:
        guestTargets.length > 0
          ? `The browser lists ${guestTargets.length} target${guestTargets.length === 1 ? "" : "s"} under this project's extension id ${guestIds.join(", ")} (from the session contract), so the guest is loaded.${
              others.length ? ` Other extensions are loaded too: ${others.join(", ")}.` : ""
            }`
          : `The browser's target list has no chrome-extension:// target under this project's extension id (${identity.expectedIds.join(" or ")}, from the session contract${
              identity.source === "dist-path" ? ", derived from its dist path" : ""
            }).${
              others.length
                ? ` It does list other extensions (${others.join(", ")}), which are not this project.`
                : ""
            } On Chrome this is the signature of a silently rejected --load-extension; ready.json carries extension_load_refused when the engine saw the refusal.`,
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
