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
import { carriersPlacedHere } from "./carrier-registry";

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

export function sweepCarriersPlacedHere(): CarrierSweepEntry[] {
  try {
    return sweepCarriers(carriersPlacedHere());
  } catch {
    return [];
  }
}

const EXIT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

let installed: Array<{
  event: NodeJS.Signals | "exit";
  handler: () => void;
}> = [];

/* @invariant
 * The server dying is one of the ways a session ends, so it cleans up too.
 *
 * extension_dev ties carrier removal to its child's exit, which covers a
 * browser closing or crashing but not this process being killed: the child is
 * killed with it and its exit handler never runs, leaving the carrier behind
 * for the next build to pack. The signal handlers below re-raise after
 * sweeping, because installing any listener for SIGINT or SIGTERM takes away
 * Node's default disposition, and a server that swallows Ctrl+C would be a
 * worse bug than the one being fixed. They only re-raise once nothing else is
 * listening, so a host that installs its own shutdown handler still owns the
 * shutdown. The sweep itself removes only carriers this process placed, is
 * idempotent because a removed carrier is forgotten, and never throws.
 */
export function installCarrierExitCleanup(): void {
  if (installed.length) return;
  const onExit = () => {
    sweepCarriersPlacedHere();
  };
  process.on("exit", onExit);
  installed.push({ event: "exit", handler: onExit });
  for (const signal of EXIT_SIGNALS) {
    const onSignal = () => {
      sweepCarriersPlacedHere();
      process.removeListener(signal, onSignal);
      installed = installed.filter((entry) => entry.handler !== onSignal);
      if (process.listenerCount(signal) === 0) {
        try {
          process.kill(process.pid, signal);
        } catch {
        }
      }
    };
    process.on(signal, onSignal);
    installed.push({ event: signal, handler: onSignal });
  }
}

export function uninstallCarrierExitCleanup(): void {
  for (const entry of installed.splice(0)) {
    process.removeListener(entry.event as NodeJS.Signals, entry.handler);
  }
}

