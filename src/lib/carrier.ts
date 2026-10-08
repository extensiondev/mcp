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

import { forgetCarrier } from "./carrier-registry";

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

type CarrierClaim =
  | { ours: true; how: "marker" | "payload" }
  | { ours: false; how: "foreign" };

function claimCarrier(target: string): CarrierClaim {
  if (fs.existsSync(path.join(target, MARKER_FILE))) {
    return { ours: true, how: "marker" };
  }

  if (deriveCarrierId(target) === CARRIER_EXTENSION_ID) {
    return { ours: true, how: "payload" };
  }

  return { ours: false, how: "foreign" };
}

const PAYLOAD_NOTE = `Its ${MARKER_FILE} marker was missing, but its manifest key derives the carrier's own extension id ${CARRIER_EXTENSION_ID}, which only the Live Preview carrier has, so it was recognised as one an earlier server placed and taken back.`;

const FOREIGN_NOTE = `extensions/${CARRIER_DIR_NAME} has no ${MARKER_FILE} marker and does not carry the carrier's own manifest key, so it is not a carrier this tool placed and was left untouched. Nothing here deletes a directory this tool did not write: rename it or move it out of ./extensions yourself.`;

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
    ...(claim.how === "marker" ? {} : { note: PAYLOAD_NOTE }),
  };
}
