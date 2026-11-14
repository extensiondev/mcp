// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { dropHeldBatch, loadHeldBatch, saveHeldBatch } from "./held-batches";

import type { HeldCreateGrant } from "./held-create-grant-words";

export {
  CREATE_IN_PROGRESS_CODE,
  grantExpiresAt,
  heldUntilSentence,
  type HeldCreateGrant,
} from "./held-create-grant-words";

export function holdCreateGrant(
  apiBase: string,
  deviceCode: string,
  target: { workspace: string; ref: string },
  held: HeldCreateGrant,
): boolean {
  return saveHeldBatch(apiBase, deviceCode, {
    workspace: target.workspace.toLowerCase(),
    refs: [target.ref.toLowerCase()],
    grant: held.grant,
    grantExpiresAt: held.grantExpiresAt,
    rows: [],
  });
}

export function heldCreateGrant(apiBase: string, deviceCode: string, ref: string): HeldCreateGrant | null {
  if (!deviceCode) return null;

  const held = loadHeldBatch<unknown>(apiBase, deviceCode);

  if (!held || held.refs.length !== 1 || held.refs[0] !== ref.toLowerCase() || held.rows.length !== 0) {
    return null;
  }

  return { grant: held.grant, grantExpiresAt: held.grantExpiresAt };
}

export function releaseCreateGrant(apiBase: string, deviceCode: string): void {
  dropHeldBatch(apiBase, deviceCode);
}
