// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import {
  SESSION_BROWSER,
  SESSION_PROJECT_PATH,
} from "../lib/common-schema";
import { CDPClient } from "../lib/cdp";
import { envelope } from "../lib/envelope";
import { isChromiumFamily, isGeckoFamily } from "../lib/browser-family";
import {
  resolveCdpPort,
  resolveRdpPort,
  CDP_PORT_MISSING_HINT,
  RDP_PORT_MISSING_HINT,
} from "../lib/cdp-port";
import { rdpListAddons } from "../lib/rdp";
import { resolveSessionBrowser } from "../lib/session-browser";
import { sessionGuestIdentity } from "../lib/extension-identity";
import { readyContractPath } from "../lib/session-paths";

export const schema = {
  name: "extension_list_extensions",
  description:
    "List the extensions in the running dev browser: id, name, version, and, on Chromium, live contexts. This session's own extension carries ownExtension:true, with name and version from the ready contract even when the browser exposes no identity. On Chromium, entries come from the live CDP targets and from the session profile's installed set, so an extension whose MV3 service worker is dormant is still listed, with running:false and no contexts. Firefox rides the RDP root actor (listAddons, engine 4.0.15 and later), so entries are installed add-ons regardless of contexts, are marked temporarilyInstalled where relevant, and carry no contexts. Other extensions' contexts are never attached to or evaluated in. This requires an active dev or start session.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      browser: SESSION_BROWSER,
    },
    required: ["projectPath"],
  },
};

interface ExtensionEntry {
  id: string;
  name?: string;
  version?: string;
  ownExtension?: boolean;
  ownExtensionInferred?: boolean;
  temporarilyInstalled?: boolean;
  running?: boolean;
  contexts: Array<{ type: string; url: string }>;
  source: "extensions-domain" | "session-contract" | "target-only" | "rdp-root" | "profile";
  note?: string;
}

interface OwnIdentity {
  ids: string[];
  name?: string;
  version?: string;
}

function readOwnIdentity(
  projectPath: string,
  browser: string,
): OwnIdentity | null {
  let contract: Record<string, unknown>;

  try {
    contract = JSON.parse(
      fs.readFileSync(readyContractPath(projectPath, browser), "utf8"),
    );
  } catch {
    return null;
  }

  const distPath =
    typeof contract?.distPath === "string" ? contract.distPath : null;
  const ids: string[] = [...sessionGuestIdentity(projectPath, browser).expectedIds];

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

interface ProfileExtension {
  id: string;
  name?: string;
  version?: string;
}

const COMPONENT_LOCATIONS = new Set([5, 10]);

function readProfileExtensions(
  projectPath: string,
  browser: string,
): ProfileExtension[] {
  let profilePath: string | null = null;

  try {
    const contract = JSON.parse(
      fs.readFileSync(readyContractPath(projectPath, browser), "utf8"),
    );

    profilePath =
      typeof contract?.profilePath === "string" ? contract.profilePath : null;
  } catch {
    return [];
  }

  if (!profilePath) return [];

  const settings: Record<string, Record<string, unknown>> = {};

  for (const file of ["Preferences", "Secure Preferences"]) {
    try {
      const prefs = JSON.parse(
        fs.readFileSync(path.join(profilePath, "Default", file), "utf8"),
      );

      Object.assign(settings, prefs?.extensions?.settings ?? {});
    } catch {
    }
  }

  const found: ProfileExtension[] = [];

  for (const [id, entry] of Object.entries(settings)) {
    if (COMPONENT_LOCATIONS.has(Number(entry?.location))) continue;

    let manifest = entry?.manifest as Record<string, unknown> | undefined;

    if (!manifest && typeof entry?.path === "string") {
      try {
        manifest = JSON.parse(
          fs.readFileSync(path.join(entry.path, "manifest.json"), "utf8"),
        );
      } catch {
      }
    }

    const name =
      typeof manifest?.name === "string" && !manifest.name.startsWith("__MSG_")
        ? manifest.name
        : undefined;
    const version =
      typeof manifest?.version === "string" ? manifest.version : undefined;

    found.push({ id, name, version });
  }

  return found;
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
    return envelope({
      ok: false,
      command: schema.name,
      status: "unsupported-browser",
      error: {
        code: "E_UNSUPPORTED_BROWSER",
        message: `Listing extensions for ${browser} is not supported: no debugging-protocol pairing exists for this browser family.`,
      },
      hint: "Target a Chromium-family (CDP) or Firefox-family (RDP) dev session.",
    });
  }

  const resolved = await resolveCdpPort(args.projectPath, browser);

  if (!resolved) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "no-session",
      error: {
        code: "E_NO_SESSION",
        message:
          "No active dev session found. Cannot connect to Chrome DevTools Protocol.",
      },
      hint: `Start a dev session first with extension_dev, then use extension_wait to confirm it is ready. ${CDP_PORT_MISSING_HINT}`,
    });
  }

  const cdpPort = resolved.port;

  const cdp = new CDPClient();

  try {
    const browserWsUrl = await CDPClient.discoverBrowserWsUrl(cdpPort);
    await cdp.connect(browserWsUrl);
    const targets = await cdp.getTargets();

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
        running: true,
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

    for (const installed of readProfileExtensions(args.projectPath, browser)) {
      const live = extensions.find((e) => e.id === installed.id);

      if (live) {
        live.name ??= installed.name;
        live.version ??= installed.version;
        continue;
      }

      const entry: ExtensionEntry = {
        id: installed.id,
        running: false,
        contexts: [],
        source: "profile",
      };

      if (installed.name !== undefined) entry.name = installed.name;
      if (installed.version !== undefined) entry.version = installed.version;

      if (own?.ids.includes(installed.id)) {
        entry.ownExtension = true;

        if (entry.name === undefined && own.name !== undefined) {
          entry.name = own.name;
          if (own.version !== undefined) entry.version = own.version;
        }
      }

      extensions.push(entry);
    }

    if (own?.name && !extensions.some((e) => e.ownExtension)) {
      const byName = extensions.filter((e) => e.name === own.name);
      if (byName.length === 1) byName[0].ownExtension = true;
    }

    for (const entry of extensions) {
      if (entry.name === undefined) entry.note = UNRESOLVED_NOTE;
    }

    extensions.sort((a, b) => {
      if ((a.ownExtension ?? false) !== (b.ownExtension ?? false)) {
        return a.ownExtension ? -1 : 1;
      }

      return (a.name ?? a.id).localeCompare(b.name ?? b.id);
    });

    const ownEntry = extensions.find((e) => e.ownExtension);

    return envelope({
      ok: true,
      command: schema.name,
      status: "listed",
      value: {
        cdpPort,
        browser,
        count: extensions.length,
        ownExtensionId: ownEntry?.id ?? null,
        extensions,
      },
      warnings: [
        "Lists every extension installed in the session profile plus any with a live context: running:true carries the live contexts (service worker or open page), running:false is installed with nothing running right now, such as a dormant MV3 service worker. ownExtension marks the extension this dev session serves, identified from the session's ready contract. Other identity is read read-only via the Extensions domain; other extensions' contexts are never attached to or evaluated in.",
      ],
    });
  } catch (error) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "cdp-failed",
      error: {
        code: "E_CDP",
        message: `Failed to list extensions: ${(error as Error).message}`,
      },
    });
  } finally {
    cdp.disconnect();
  }
}

async function listGeckoExtensions(
  projectPath: string,
  browser: string,
): Promise<string> {
  const resolved = await resolveRdpPort(projectPath, browser);

  if (!resolved) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "no-session",
      error: {
        code: "E_NO_SESSION",
        message:
          "No active dev session with a Firefox debugger server (RDP) found.",
      },
      hint: `Start a dev session first with extension_dev, then use extension_wait to confirm it is ready. ${RDP_PORT_MISSING_HINT}`,
    });
  }

  const rdpPort = resolved.port;

  try {
    const addons = await rdpListAddons(rdpPort);

    const own = readOwnIdentity(projectPath, browser);

    const extensions: ExtensionEntry[] = addons
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

    if (own?.name) {
      const byName = extensions.filter((e) => e.name === own.name);
      if (byName.length === 1) byName[0].ownExtension = true;
    }

    if (!extensions.some((e) => e.ownExtension)) {
      const temporary = extensions.filter((e) => e.temporarilyInstalled);

      if (temporary.length === 1) {
        temporary[0].ownExtension = true;
        temporary[0].ownExtensionInferred = true;

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

    return envelope({
      ok: true,
      command: schema.name,
      status: "listed",
      value: {
        rdpPort,
        browser,
        count: extensions.length,
        ownExtensionId: ownEntry?.id ?? null,
        ...(ownEntry?.ownExtensionInferred ? { ownExtensionInferred: true } : {}),
        extensions,
      },
      warnings: [
        ownEntry?.ownExtensionInferred
          ? `No installed add-on carries this session's name${own?.name ? ` ("${own.name}")` : ""}, so ${ownEntry.id} is marked ownExtension only because it is the one temporary install. That is an inference: if this project's add-on failed to install, it may be another temporary add-on such as the engine's companion. extension_logs shows whether the install succeeded.`
          : null,
        "Lists INSTALLED add-ons via the RDP root actor (listAddons), regardless of whether a context is currently live, so entries carry no contexts. temporarilyInstalled marks temporary loads; ownExtension marks the extension this dev session serves, matched from the session's ready contract. Add-ons are never attached to or evaluated in.",
      ],
    });
  } catch (error) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "rdp-failed",
      error: {
        code: "E_RDP",
        message: `Failed to list extensions over RDP: ${(error as Error).message}`,
      },
    });
  }
}
