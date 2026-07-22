// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CDPClient } from "../lib/cdp";
import { isChromiumFamily, isGeckoFamily } from "../lib/browser-family";
import {
  resolveCdpPort,
  resolveRdpPort,
  CDP_PORT_MISSING_HINT,
  RDP_PORT_MISSING_HINT,
} from "../lib/cdp-port";
import { rdpListAddons } from "../lib/rdp";
import { resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_list_extensions",
  description:
    "List the extensions in the running dev browser. Returns each extension's id, name, version, and (on Chromium) live contexts. The entry for THIS dev session's extension (the project being served) is flagged ownExtension: true, with name and version resolved from the session's ready contract even when the browser exposes no identity. On Chromium this rides the Chrome DevTools Protocol: entries are extensions with at least one live context (a dormant MV3 service worker with no open page may be absent until it wakes), and other extensions resolve via the read-only Extensions domain when available. On Firefox this rides the Remote Debugging Protocol root actor (listAddons, engine 4.0.15+): entries are INSTALLED add-ons regardless of live contexts, with temporarilyInstalled marking temporary loads, and carry no contexts. Either way other extensions' contexts are never attached to or evaluated in. Requires an active dev or start session.",
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
  ownExtension?: boolean;
  temporarilyInstalled?: boolean;
  contexts: Array<{ type: string; url: string }>;
  source: "extensions-domain" | "session-contract" | "target-only" | "rdp-root";
  note?: string;
}

// Chrome derives an UNPACKED extension's id from the SHA-256 of its absolute
// directory path: the first 16 bytes, each nibble mapped 0-15 onto 'a'-'p'.
// Recomputing it is deterministic and needs no browser round-trip. Mirrors
// resolveExtensionId in open.ts, which caught live that a dev session ALSO
// loads Extension.js's own manager extension, so "some chrome-extension://
// target" is frequently not the project's.
function unpackedExtensionId(distPath: string): string {
  const digest = crypto.createHash("sha256").update(distPath).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

interface OwnIdentity {
  // Path-derived id candidates: the dist path as the contract records it plus
  // its realpath, in case the engine loaded through a symlink (/tmp on macOS).
  ids: string[];
  name?: string;
  version?: string;
}

// The identity of the extension THIS session serves, from the ready contract
// the engine writes (it stamps extensionName/extensionVersion and the distPath
// it actually loaded). Falls back to the built manifest next to that distPath
// for engines that predate the identity stamp.
function readOwnIdentity(
  projectPath: string,
  browser: string,
): OwnIdentity | null {
  let contract: Record<string, unknown>;
  try {
    const file = path.resolve(
      projectPath,
      "dist",
      "extension-js",
      browser,
      "ready.json",
    );
    contract = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }

  const distPath =
    typeof contract?.distPath === "string" ? contract.distPath : null;
  const ids: string[] = [];
  if (distPath) {
    ids.push(unpackedExtensionId(distPath));
    try {
      const real = fs.realpathSync(distPath);
      if (real !== distPath) ids.push(unpackedExtensionId(real));
    } catch {
    }
  }

  let name =
    typeof contract?.extensionName === "string"
      ? contract.extensionName
      : undefined;
  let version =
    typeof contract?.extensionVersion === "string"
      ? contract.extensionVersion
      : undefined;

  if ((!name || !version) && distPath) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(distPath, "manifest.json"), "utf8"),
      );
      // A __MSG_*__ placeholder is worse than no name: it is not what the
      // browser displays. Skip it rather than surface the raw key.
      if (
        !name &&
        typeof manifest?.name === "string" &&
        !manifest.name.startsWith("__MSG_")
      ) {
        name = manifest.name;
      }
      if (!version && typeof manifest?.version === "string") {
        version = manifest.version;
      }
    } catch {
    }
  }

  if (ids.length === 0 && !name) return null;
  return { ids, name, version };
}

const UNRESOLVED_NOTE =
  "Identity unresolved: the browser's Extensions CDP domain returned nothing for this id, and other extensions' contexts are never attached to or evaluated in to read a manifest.";

export async function handler(args: {
  projectPath: string;
  browser?: string;
}): Promise<string> {
  const { browser } = resolveSessionBrowser(
    args.projectPath,
    args.browser,
    "chrome",
  );
  if (isGeckoFamily(browser)) {
    return listGeckoExtensions(args.projectPath, browser);
  }
  if (!isChromiumFamily(browser)) {
    return JSON.stringify({
      error: `Listing extensions for ${browser} is not supported: no debugging-protocol pairing exists for this browser family.`,
      hint: "Target a Chromium-family (CDP) or Firefox-family (RDP) dev session.",
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

    const own = readOwnIdentity(args.projectPath, browser);

    const extensions: ExtensionEntry[] = [];
    for (const [id, ctxTargets] of byId) {
      const entry: ExtensionEntry = {
        id,
        contexts: ctxTargets.map((c) => ({ type: c.type, url: c.url })),
        source: "target-only",
      };

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
      }

      if (own?.ids.includes(id)) {
        entry.ownExtension = true;
        if (entry.name === undefined && own.name !== undefined) {
          entry.name = own.name;
          if (own.version !== undefined) entry.version = own.version;
          entry.source = "session-contract";
        }
      }

      extensions.push(entry);
    }

    // The path-derived id can miss (a profile-relocated or key-pinned load).
    // When it does but the Extensions domain DID resolve a name that matches
    // the contract's, that entry is the session's extension all the same.
    if (own?.name && !extensions.some((e) => e.ownExtension)) {
      const byName = extensions.filter((e) => e.name === own.name);
      if (byName.length === 1) byName[0].ownExtension = true;
    }

    for (const entry of extensions) {
      if (entry.name === undefined) entry.note = UNRESOLVED_NOTE;
    }

    // Own extension first: it is the one the caller is developing, and the one
    // every follow-up tool call targets.
    extensions.sort((a, b) => {
      if ((a.ownExtension ?? false) !== (b.ownExtension ?? false)) {
        return a.ownExtension ? -1 : 1;
      }
      return (a.name ?? a.id).localeCompare(b.name ?? b.id);
    });

    const ownEntry = extensions.find((e) => e.ownExtension);
    return JSON.stringify({
      cdpPort,
      browser,
      count: extensions.length,
      ownExtensionId: ownEntry?.id ?? null,
      extensions,
      note:
        "Lists extensions that currently have at least one live context (service worker or open page). An MV3 service worker that has gone dormant with no open page may be absent until it wakes. ownExtension marks the extension this dev session serves, identified from the session's ready contract. Other identity is read read-only via the Extensions domain; other extensions' contexts are never attached to or evaluated in.",
    });
  } catch (error) {
    return JSON.stringify({
      error: `Failed to list extensions: ${(error as Error).message}`,
    });
  } finally {
    cdp.disconnect();
  }
}

// Firefox pairing: the RDP root actor's listAddons is the only channel that can
// see add-ons the in-bundle control relay does not live in (upstream entry 78:
// the engine stamps rdpPort into ready.json from 4.0.15 on). Root-level listing
// only; add-on targets are never attached to or evaluated in.
async function listGeckoExtensions(
  projectPath: string,
  browser: string,
): Promise<string> {
  const resolved = await resolveRdpPort(projectPath, browser);
  if (!resolved) {
    return JSON.stringify({
      error:
        "No active dev session with a Firefox debugger server (RDP) found.",
      hint: `Start a dev session first with extension_dev, then use extension_wait to confirm it is ready. ${RDP_PORT_MISSING_HINT}`,
    });
  }
  const rdpPort = resolved.port;

  try {
    let addons: Awaited<ReturnType<typeof rdpListAddons>> | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        addons = await rdpListAddons(rdpPort);
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }
    }
    if (!addons) throw lastError;

    const own = readOwnIdentity(projectPath, browser);

    const extensions: ExtensionEntry[] = addons
      // Strictly isWebExtension === true: GMP plugins (Widevine, OpenH264)
      // come back from listAddons WITHOUT the field at all (verified live
      // against Firefox via the canary engine), while every real extension
      // and theme carries it, built-in system add-ons included.
      .filter(
        (addon) =>
          addon.isWebExtension === true &&
          addon.isSystem !== true &&
          addon.hidden !== true,
      )
      .map((addon) => {
        const entry: ExtensionEntry = {
          id: String(addon.id ?? addon.actor ?? ""),
          contexts: [],
          source: "rdp-root",
        };
        if (typeof addon.name === "string") entry.name = addon.name;
        if (typeof addon.version === "string") entry.version = addon.version;
        if (addon.temporarilyInstalled === true) {
          entry.temporarilyInstalled = true;
        }
        return entry;
      });

    // The Chromium path derives the own id from the dist path; Gecko add-on ids
    // come from the manifest (or a generated temp id), so match on the identity
    // the ready contract stamps instead. A temp install is the fallback signal:
    // the dev session's extension is loaded temporarily, so a lone
    // temporarilyInstalled entry is it even when the names disagree.
    if (own?.name) {
      const byName = extensions.filter((e) => e.name === own.name);
      if (byName.length === 1) byName[0].ownExtension = true;
    }
    if (!extensions.some((e) => e.ownExtension)) {
      const temporary = extensions.filter((e) => e.temporarilyInstalled);
      if (temporary.length === 1) {
        temporary[0].ownExtension = true;
        if (temporary[0].name === undefined && own?.name !== undefined) {
          temporary[0].name = own.name;
          if (own.version !== undefined) temporary[0].version = own.version;
          temporary[0].source = "session-contract";
        }
      }
    }

    extensions.sort((a, b) => {
      if ((a.ownExtension ?? false) !== (b.ownExtension ?? false)) {
        return a.ownExtension ? -1 : 1;
      }
      return (a.name ?? a.id).localeCompare(b.name ?? b.id);
    });

    const ownEntry = extensions.find((e) => e.ownExtension);
    return JSON.stringify({
      rdpPort,
      browser,
      count: extensions.length,
      ownExtensionId: ownEntry?.id ?? null,
      extensions,
      note:
        "Lists INSTALLED add-ons via the RDP root actor (listAddons), regardless of whether a context is currently live, so entries carry no contexts. temporarilyInstalled marks temporary loads; ownExtension marks the extension this dev session serves, matched from the session's ready contract. Add-ons are never attached to or evaluated in.",
    });
  } catch (error) {
    return JSON.stringify({
      error: `Failed to list extensions over RDP: ${(error as Error).message}`,
    });
  }
}
