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

export function installCarrierExitCleanup(): void {
  if (installed.length) return;

  const onExit = () => {
    sweepCarriersPlacedHere();
  };

  process.on("exit", onExit);
  installed.push({ event: "exit", handler: onExit });

  const signalHandler = (signal: NodeJS.Signals) => {
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

    return onSignal;
  };

  for (const signal of EXIT_SIGNALS) {
    const onSignal = signalHandler(signal);

    process.on(signal, onSignal);
    installed.push({ event: signal, handler: onSignal });
  }
}


