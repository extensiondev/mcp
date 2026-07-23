// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

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

export type CarrierMaterialization = {
  loaded: boolean;
  path?: string;
  note: string;
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
  const target = path.join(projectPath, "extensions", CARRIER_DIR_NAME);
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
          note: "Safe to delete; extension_dev recreates it when carrier: true. Add extensions/ to .gitignore if you do not want it tracked.",
        },
        null,
        2,
      )}\n`,
    );
    return {
      loaded: true,
      path: target,
      note:
        "Live-preview carrier placed in ./extensions; Extension.js loads it as a companion beside your extension. " +
        "Open https://inspect.extension.dev/?session=live in the dev browser to watch the session's real-lane chrome.* trace on the Trace tab.",
    };
  } catch (error) {
    return {
      loaded: false,
      path: target,
      note: `Could not place the carrier: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
