// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";

import { CARRIER_EXTENSION_ID } from "./carrier";
import { readyContractPath } from "./session-paths";

const STATIC_COMPANION_IDS = new Set<string>([
  "kgdaecdpfkikjncaalnmmnjjfpofkcbl",
  CARRIER_EXTENSION_ID,
]);

export function unpackedExtensionId(distPath: string): string {
  const digest = crypto.createHash("sha256").update(distPath).digest();
  let id = "";

  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i]! >> 4));
    id += String.fromCharCode(97 + (digest[i]! & 0x0f));
  }

  return id;
}

export interface GuestIdentity {
  expectedIds: string[];
  companionIds: Set<string>;
  source: "contract" | "dist-path" | "none";
}

export function sessionGuestIdentity(projectPath: string, browser: string): GuestIdentity {
  const companionIds = new Set(STATIC_COMPANION_IDS);
  let contract: Record<string, unknown> | null;

  try {
    contract = JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8"));
  } catch {
    contract = null;
  }

  for (const record of Array.isArray(contract?.managedExtensions) ? contract.managedExtensions : []) {
    const id = String((record as { id?: unknown })?.id ?? "").trim().toLowerCase();
    if (/^[a-p]{32}$/.test(id)) companionIds.add(id);
  }

  const stamped = String(contract?.extensionId ?? "").trim().toLowerCase();

  if (/^[a-p]{32}$/.test(stamped)) {
    return { expectedIds: [stamped], companionIds, source: "contract" };
  }

  const distPath = typeof contract?.distPath === "string" ? contract.distPath : "";

  if (distPath) {
    const ids = [unpackedExtensionId(distPath)];

    try {
      const real = fs.realpathSync(distPath);
      if (real !== distPath) ids.push(unpackedExtensionId(real));
    } catch {
    }

    return { expectedIds: ids, companionIds, source: "dist-path" };
  }

  return { expectedIds: [], companionIds, source: "none" };
}
