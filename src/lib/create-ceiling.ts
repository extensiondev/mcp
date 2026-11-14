// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { creatingAgeAt, type CreatingAge } from "./create-ceiling-words";
import { loadHeldBatch, saveHeldBatch } from "./held-batches";

export {
  CREATE_CEILING_SENTENCE,
  CREATE_STUCK_AFTER_SECONDS,
  creatingAgeAt,
  creatingForWords,
  type CreatingAge,
} from "./create-ceiling-words";

export function firstSeenCreating(apiBase: string, deviceCode: string, now: number, kept: boolean): number {
  if (!kept) return now;

  const held = loadHeldBatch<unknown>(apiBase, deviceCode);
  if (!held) return now;

  if (typeof held.creatingSince === "number" && held.creatingSince > 0 && held.creatingSince <= now) {
    return held.creatingSince;
  }

  saveHeldBatch(apiBase, deviceCode, { ...held, creatingSince: now });

  return now;
}

export function creatingAge(args: {
  apiBase: string;
  deviceCode: string;
  kept: boolean;
  data: Record<string, unknown>;
}): CreatingAge {
  const now = Date.now();

  return creatingAgeAt(args.data, now, firstSeenCreating(args.apiBase, args.deviceCode, now, args.kept));
}
