// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isChromiumFamily } from "./browser-family";

/**
 * The Extension.dev Live Preview carrier, bundled prebuilt in this package
 * under extensions/live-preview/<engine>. extension_dev materializes it into
 * the project's ./extensions folder (which Extension.js auto-scans and loads
 * as a companion next to the user's extension), so the dev browser comes up
 * carrier-equipped: web pages the carrier allowlists (inspect.extension.dev,
 * localhost) can then watch the session's real-lane trace and pair with it.
 */

export const CARRIER_DIR_NAME = "extension-dev-live-preview";

/** Marker proving the directory is ours to overwrite on version updates. */
const MARKER_FILE = "managed-by-extension-dev-mcp.json";

/**
 * The carrier's extension id, DERIVED from the payload's own manifest key
 * rather than hardcoded, so it cannot drift if the key is ever regenerated.
 *
 * Chrome's rule for a keyed extension: SHA-256 the DER public key, take the
 * first 16 bytes, and map each nibble onto 'a'-'p'.
 */
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

/** Where the carrier lands inside a project. */
export function carrierPath(projectPath: string): string {
  return path.join(projectPath, "extensions", CARRIER_DIR_NAME);
}

/** True only for a directory carrying our marker, i.e. ours to delete. */
export function isManagedCarrier(projectPath: string): boolean {
  return fs.existsSync(path.join(carrierPath(projectPath), MARKER_FILE));
}

export type CarrierRemoval = {
  removed: boolean;
  path: string;
  /** Present when something was there but was NOT ours to touch. */
  note?: string;
};

/**
 * Remove the carrier from a project, marker-guarded.
 *
 * The trace swarm's most release-dangerous finding was that a debugging flag
 * leaves a permanent companion extension in the project: it survived
 * extension_stop, Extension.js auto-scans ./extensions, and the first
 * `git add -A` vendors it. Nothing removed it, ever. Stop and build both call
 * this now, and `extension_dev carrier: true` puts it back on demand.
 */
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
  // Leave no empty scaffolding behind: the folder is ours only while the
  // carrier is in it.
  const parent = path.join(projectPath, "extensions");
  try {
    if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch {
  }
  return { removed: true, path: target };
}

/**
 * Keep the carrier out of the user's commits. The scaffolder runs `git init`
 * with no initial commit, so the first `git add -A` in a project that ever ran
 * with carrier: true vendors 460K of somebody else's extension.
 * Returns the line added, or null when nothing needed doing.
 */
export function ensureCarrierIgnored(projectPath: string): string | null {
  if (!fs.existsSync(path.join(projectPath, ".git"))) return null;
  const entry = `extensions/${CARRIER_DIR_NAME}/`;
  const file = path.join(projectPath, ".gitignore");
  let current = "";
  try {
    current = fs.readFileSync(file, "utf-8");
  } catch {
  }
  const ignored = current
    .split("\n")
    .map((line) => line.trim())
    .some(
      (line) =>
        line === entry ||
        line === `extensions/${CARRIER_DIR_NAME}` ||
        line === "extensions/" ||
        line === "extensions",
    );
  if (ignored) return null;
  try {
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(
      file,
      `${prefix}\n# Extension.dev live-preview carrier: a local debug companion, not part of your extension.\n${entry}\n`,
    );
    return entry;
  } catch {
    return null;
  }
}

export type CarrierMaterialization = {
  loaded: boolean;
  path?: string;
  note: string;
  /** The .gitignore entry this run added, when it added one. */
  gitignored?: string;
  /**
   * What the carrier lane CANNOT do, stated at the moment it is handed over.
   * The trace swarm's top finding was that the real lane's boundaries were
   * discoverable only by experiment: 14 personas independently filed the
   * carrier-identity scoping as a severe bug, and 10 more expected the trace
   * to show their own extension's calls. Both are honest constraints; neither
   * was written down anywhere the caller would look.
   */
  limitations?: string[];
  /**
   * How to actually DRIVE the real lane. Seven personas reached a
   * permanently empty trace and concluded the feature was broken, because
   * nothing in the 33 tool schemas, this note, or the rendered page named the
   * carrier's extension id or its message envelopes. Every persona that did
   * reach the real lane used out-of-band knowledge of the emulator source.
   */
  bridgeProtocol?: {
    carrierExtensionId: string;
    allowedOrigins: string;
    howTo: string;
    example: string;
  };
};

/** Walk up from this module until the bundled payload directory is found. */
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

/**
 * Copy the bundled carrier into <projectPath>/extensions/<CARRIER_DIR_NAME>.
 * Refuses to touch an existing directory that lacks our marker file (it is
 * the user's, not ours); otherwise replaces it so version updates propagate.
 */
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
        "Open https://inspect.extension.dev/?session=live in the dev browser (any http://localhost origin works too) " +
        "to watch the session's real-lane chrome.* trace on the Trace tab. " +
        "It is a debug companion, never part of a release: extension_stop and extension_build remove it again" +
        (ignored ? `, and ${ignored} was added to .gitignore.` : "."),
      limitations: [
        "The trace shows calls a PAGE bridges to the carrier. Your extension's own chrome.* calls run directly in its contexts and never cross the carrier, so they do not appear.",
        "Bridged calls run under the CARRIER's identity, not your extension's. The preview assumes a single active guest and does not namespace per-extension state, so storage, action/badge state, messaging delivery, offscreen documents and relative script paths belong to the carrier. Rows affected are badged carrier-scoped in the Trace tab.",
        "Chromium-family only: Firefox has no externally_connectable channel for web pages.",
      ],
      ...(carrierId
        ? {
            bridgeProtocol: {
              carrierExtensionId: carrierId,
              allowedOrigins:
                "https://inspect.extension.dev, https://intelligence.extension.dev, https://themes.extension.dev, http://localhost/*, http://127.0.0.1/*",
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
