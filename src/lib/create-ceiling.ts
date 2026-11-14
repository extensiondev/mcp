// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { creatingAgeAt, type CreatingAge } from "./create-ceiling-words";
import { kernelHook } from "./kernel-hooks";

export {
  CREATE_CEILING_SENTENCE,
  CREATE_STUCK_AFTER_SECONDS,
  creatingAgeAt,
  creatingForWords,
  type CreatingAge,
} from "./create-ceiling-words";

export async function firstSeenCreating(apiBase: string, deviceCode: string, now: number, kept: boolean): Promise<number> {
  if (!kept) return now;

  const state = kernelHook("approvalState")();
  const held = await state.loadHeldBatch<unknown>(apiBase, deviceCode);
  if (!held) return now;

  if (typeof held.creatingSince === "number" && held.creatingSince > 0 && held.creatingSince <= now) {
    return held.creatingSince;
  }

  await state.saveHeldBatch(apiBase, deviceCode, { ...held, creatingSince: now });

  return now;
}

export async function creatingAge(args: {
  apiBase: string;
  deviceCode: string;
  kept: boolean;
  data: Record<string, unknown>;
}): Promise<CreatingAge> {
  const now = Date.now();

  return creatingAgeAt(args.data, now, await firstSeenCreating(args.apiBase, args.deviceCode, now, args.kept));
}
