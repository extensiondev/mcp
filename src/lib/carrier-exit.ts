// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";

import {
  carrierPath,
  removeCarrier,
  type CarrierRemoval,
} from "./carrier";

export type CarrierSweepEntry = CarrierRemoval & { projectPath: string };

export function sweepCarriers(projectPaths: string[]): CarrierSweepEntry[] {
  const out: CarrierSweepEntry[] = [];
  const seen = new Set<string>();

  for (const projectPath of projectPaths) {
    const resolved = path.resolve(projectPath);
    if (seen.has(resolved)) continue;

    seen.add(resolved);

    try {
      const removal = removeCarrier(resolved);
      if (!removal.removed && !removal.note) continue;

      out.push({ projectPath: resolved, ...removal });
    } catch (error) {
      out.push({
        projectPath: resolved,
        removed: false,
        path: carrierPath(resolved),
        note: `Could not remove the carrier: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return out;
}
