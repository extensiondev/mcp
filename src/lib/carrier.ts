// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isChromiumFamily } from "./browser-family";
import { ensureProjectIgnored } from "./project-ignore";


export const CARRIER_DIR_NAME = "extension-dev-live-preview";

export const CARRIER_EXTENSION_ID = "ibppeifnekhjjjmpjfiobccjlicbmgcb";

const MARKER_FILE = "managed-by-extension-dev-mcp.json";

function deriveCarrierId(source: string): string | null {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(source, "manifest.json"), "utf-8"),
    ) as { key?: string };
    if (!manifest.key) return null;
    const hash = createHash("sha256")
      .update(Buffer.from(manifest.key, "base64"))
      .digest();
    return [...hash.subarray(0, 16)]
      .map(
        (byte) =>
          String.fromCharCode(97 + (byte >> 4)) +
          String.fromCharCode(97 + (byte & 15)),
      )
      .join("");
  } catch {
    return null;
  }
}

export function carrierPath(projectPath: string): string {
  return path.join(projectPath, "extensions", CARRIER_DIR_NAME);
}

export function isManagedCarrier(projectPath: string): boolean {
  return fs.existsSync(path.join(carrierPath(projectPath), MARKER_FILE));
}

export type CarrierRemoval = {
  removed: boolean;
  path: string;
  note?: string;
};

export function removeCarrier(projectPath: string): CarrierRemoval {
  const target = carrierPath(projectPath);
  if (!fs.existsSync(target)) return { removed: false, path: target };
  if (!fs.existsSync(path.join(target, MARKER_FILE))) {
    return {
      removed: false,
      path: target,
      note: `extensions/${CARRIER_DIR_NAME} has no ${MARKER_FILE} marker, so it is not the carrier this tool placed and was left untouched.`,
    };
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    return {
      removed: false,
      path: target,
      note: `Could not remove the carrier: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parent = path.join(projectPath, "extensions");
  try {
    if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch {
  }
  return { removed: true, path: target };
}

export function ensureCarrierIgnored(projectPath: string): string | null {
  const outcome = ensureProjectIgnored(projectPath, {
    entry: `extensions/${CARRIER_DIR_NAME}/`,
    aliases: [
      `extensions/${CARRIER_DIR_NAME}`,
      "extensions/",
      "extensions",
    ],
    comment:
      "# Extension.dev live-preview carrier: a local debug companion, not part of your extension.",
  });
  return outcome.state === "added" ? outcome.entry : null;
}

export type CarrierMaterialization = {
  loaded: boolean;
  path?: string;
  note: string;
  gitignored?: string;
  limitations?: string[];
  graduation?: string;
  bridgeProtocol?: {
    carrierExtensionId: string;
    allowedOrigins: string;
    howTo: string;
    example: string;
  };
};

function findBundledCarrier(engine: string): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, "extensions", "live-preview", engine);
    if (fs.existsSync(path.join(candidate, "manifest.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function materializeCarrier(
  projectPath: string,
  browser: string,
): CarrierMaterialization {
  if (!isChromiumFamily(browser)) {
    return {
      loaded: false,
      note:
        `The live-preview carrier is Chromium-family only for now (requested: ${browser}). ` +
        "Firefox has no externally_connectable channel for web pages, so the carrier pairing cannot work there.",
    };
  }
  const source = findBundledCarrier("chromium");
  if (!source) {
    return {
      loaded: false,
      note: "This install ships no bundled carrier payload (extensions/live-preview/chromium missing from the package).",
    };
  }
  const target = carrierPath(projectPath);
  const marker = path.join(target, MARKER_FILE);
  if (fs.existsSync(target) && !fs.existsSync(marker)) {
    return {
      loaded: false,
      path: target,
      note:
        `A directory already exists at extensions/${CARRIER_DIR_NAME} without the ${MARKER_FILE} marker, ` +
        "so it is not managed by this tool and was left untouched. Remove or rename it to let extension_dev place the carrier there.",
    };
  }
  const carrierId = deriveCarrierId(source);
  try {
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(source, "manifest.json"), "utf-8"),
    ) as { version?: string };
    fs.writeFileSync(
      marker,
      `${JSON.stringify(
        {
          managedBy: "@extension.dev/mcp",
          carrierVersion: manifest.version ?? "unknown",
          note: "Safe to delete; extension_dev recreates it when carrier: true. extension_stop and extension_build remove it for you.",
        },
        null,
        2,
      )}\n`,
    );
    const ignored = ensureCarrierIgnored(projectPath);
    return {
      loaded: true,
      path: target,
      ...(ignored ? { gitignored: ignored } : {}),
      note:
        "Live-preview carrier placed in ./extensions; Extension.js loads it as a companion beside your extension. " +
        "Open https://preview.extension.dev/?session=live in the dev browser (any http://localhost origin works too) " +
        "to watch the session's real-lane chrome.* trace on the Trace tab. " +
        "It is a debug companion, never part of a release: extension_stop and extension_build remove it again" +
        (ignored ? `, and ${ignored} was added to .gitignore.` : "."),
      limitations: [
        "The trace shows calls a PAGE bridges to the carrier. Your extension's own chrome.* calls run directly in its contexts and never cross the carrier, so they do not appear.",
        "Bridged calls run under the CARRIER's identity, not your extension's. The preview assumes a single active guest and does not namespace per-extension state, so storage, action/badge state, messaging delivery, offscreen documents and relative script paths belong to the carrier. Rows affected are badged carrier-scoped in the Trace tab.",
        "Chromium-family only: Firefox has no externally_connectable channel for web pages.",
      ],
      graduation:
        "The carrier lane is the SHARED real lane: bridged calls run as the carrier, by design (see limitations). Your guest is already loaded as ITSELF in this same session, so for its own storage, identity, badge and messaging (the isolated real thing), drive the guest directly instead of the carrier bridge: extension_storage, extension_eval and extension_dom_snapshot against this projectPath all operate on the guest as itself. Start (or replace) this session with allowControl: true (or allowEval: true) to unlock them. Use the carrier bridge for the shared real-lane TRACE; use the control verbs for the guest's OWN state.",
      ...(carrierId
        ? {
            bridgeProtocol: {
              carrierExtensionId: carrierId,
              allowedOrigins:
                "https://preview.extension.dev, https://code.extension.dev, https://themes.extension.dev, http://localhost/*, http://127.0.0.1/*",
              howTo:
                "From a page on an allowed origin, register your guest once with a 'session' message (it declares the permissions the carrier enforces), then send 'bridge' messages to run chrome.* for real; each one streams into the Trace tab. Use the EXACT dotted wire names the bridge dispatcher accepts: storage is storage.get/set/remove/clear with the AREA AS AN ARGUMENT, NOT storage.local.get.",
              example: [
                `const id = '${carrierId}'`,
                "const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(id, msg, r))",
                "await send({ type: 'extensiondev:session', extensionId: 'my-guest', permissions: ['storage'] })",
                "await send({ type: 'extensiondev:bridge', request: { type: 'EXTENSION_BRIDGE_REQUEST', extensionId: 'my-guest', requestId: 'r1', api: 'storage.get', args: [null, 'local'] } })",
              ].join("\n"),
            },
          }
        : {}),
    };
  } catch (error) {
    return {
      loaded: false,
      path: target,
      note: `Could not place the carrier: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
