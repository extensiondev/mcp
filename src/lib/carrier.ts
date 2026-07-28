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
import { forgetCarrier, rememberCarrier } from "./carrier-registry";


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
  return claimCarrier(carrierPath(projectPath)).ours;
}

function relativeFiles(dir: string, base = dir, depth = 0): string[] | null {
  if (depth > 4) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = relativeFiles(full, base, depth + 1);
      if (nested === null) return null;
      out.push(...nested);
      continue;
    }
    out.push(path.relative(base, full));
    if (out.length > 500) return null;
  }
  return out;
}

export type CarrierClaim =
  | { ours: true; how: "marker" | "payload" | "partial" }
  | { ours: false; how: "foreign" };

/* @invariant
 * The marker is the usual proof of ownership, never the only one.
 *
 * Removal and replacement were both gated on managed-by-extension-dev-mcp.json
 * alone, so a copy, a mv or a materialization that died between cpSync and the
 * marker write left a directory this tool had placed and could then never take
 * back: extension_stop and extension_build refused it forever, and
 * materializeCarrier refused to overwrite it, which locks the carrier lane out
 * of that project with no way forward that does not ask the user to delete
 * something by hand. The payload itself carries proof the marker cannot beat: a
 * manifest key that hashes to the carrier's own extension id, which nothing but
 * this package's payload has. A half-copied directory has no manifest at all,
 * so the second recogniser accepts one only when every file in it is also a
 * file of the bundled payload. Anything else stays foreign and is never
 * touched.
 */
export function claimCarrier(target: string): CarrierClaim {
  if (fs.existsSync(path.join(target, MARKER_FILE))) {
    return { ours: true, how: "marker" };
  }
  if (deriveCarrierId(target) === CARRIER_EXTENSION_ID) {
    return { ours: true, how: "payload" };
  }
  if (fs.existsSync(path.join(target, "manifest.json"))) {
    return { ours: false, how: "foreign" };
  }
  const source = findBundledCarrier("chromium");
  const bundled = source ? relativeFiles(source) : null;
  const present = relativeFiles(target);
  if (!bundled || !present) return { ours: false, how: "foreign" };
  const known = new Set(bundled);
  return present.every((file) => known.has(file))
    ? { ours: true, how: "partial" }
    : { ours: false, how: "foreign" };
}

const RECOVERY_NOTE: Record<"payload" | "partial", string> = {
  payload: `Its ${MARKER_FILE} marker was missing, but its manifest key derives the carrier's own extension id ${CARRIER_EXTENSION_ID}, which only this package's payload has, so it was recognised as ours and taken back.`,
  partial: `Its ${MARKER_FILE} marker was missing and it holds no manifest, but every file in it belongs to the bundled carrier payload, so it was recognised as a half-written copy of ours and taken back.`,
};

const FOREIGN_NOTE = `extensions/${CARRIER_DIR_NAME} has no ${MARKER_FILE} marker, does not carry the carrier's own manifest key, and holds files this package never ships, so it is not the carrier this tool placed and was left untouched. Nothing here deletes a directory this tool did not write: rename it or move it out of ./extensions yourself if you want the carrier to live at that path.`;

export type CarrierRemoval = {
  removed: boolean;
  path: string;
  note?: string;
};

export function removeCarrier(projectPath: string): CarrierRemoval {
  const target = carrierPath(projectPath);
  if (!fs.existsSync(target)) {
    forgetCarrier(projectPath);
    return { removed: false, path: target };
  }
  const claim = claimCarrier(target);
  if (!claim.ours) {
    return { removed: false, path: target, note: FOREIGN_NOTE };
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
  forgetCarrier(projectPath);
  const parent = path.join(projectPath, "extensions");
  try {
    if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch {
  }
  return {
    removed: true,
    path: target,
    ...(claim.how === "marker" ? {} : { note: RECOVERY_NOTE[claim.how] }),
  };
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
  const claim = fs.existsSync(target)
    ? claimCarrier(target)
    : ({ ours: true, how: "marker" } as CarrierClaim);
  if (!claim.ours) {
    return {
      loaded: false,
      path: target,
      note:
        `A directory already exists at extensions/${CARRIER_DIR_NAME} that this tool did not place: ` +
        `no ${MARKER_FILE} marker, no carrier manifest key, and files this package never ships. ` +
        "It was left untouched. Rename it or move it out of ./extensions to let extension_dev place the carrier there.",
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
    rememberCarrier(projectPath);
    const ignored = ensureCarrierIgnored(projectPath);
    return {
      loaded: true,
      path: target,
      ...(ignored ? { gitignored: ignored } : {}),
      note:
        "Live-preview carrier placed in ./extensions; Extension.js loads it as a companion beside your extension. " +
        "Open https://preview.extension.dev/ in the dev browser, load a build from this machine, and switch the lane toggle to Real " +
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
                "https://preview.extension.dev, https://code.extension.dev, https://themes.extension.dev, and those same apps' dev servers on http://localhost and http://127.0.0.1 (ports 3103, 3104, 3110, 3111). The carrier checks the sender's origin, so a page on any other localhost port is refused.",
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
