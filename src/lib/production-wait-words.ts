// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators


import { debugPortWords, productionDebugPortOutlook } from "./production-launch";
import { waitCall } from "./production-receipt";

import type { ProductionLaunchEvidence } from "./production-launch";
import type { ReadyContract } from "./types";

const BRIDGE_VERBS = "extension_storage, extension_reload, extension_open with a surface, extension_dom_snapshot by tab and extension_eval";

const DEBUG_PORT_READS = "extension_open {url}, extension_assert, extension_screenshot and extension_dom_snapshot by url";

const ARTIFACT = "To check the production artifact, extension_build reports its summary and extension_preview_web renders the built dist.";

function closing(contract: ReadyContract, launch: ProductionLaunchEvidence, projectPath: string, browser: string): string {
  if (launch.extensionLoaded === true) {
    return `The load is proven over the debug port ${launch.cdpPort}, which ${DEBUG_PORT_READS} read now; nothing here needs extension_dev.`;
  }

  const outlook = productionDebugPortOutlook(contract);
  const again = `Call ${waitCall(projectPath, browser)} again`;

  if (outlook.kind === "never") {
    const words = debugPortWords(outlook);

    return typeof contract.controlPort === "number"
      ? `${words[0].toUpperCase()}${words.slice(1)} (its answer carries guestLoaded); here the background connecting to the control channel is the proof ${again.replace("Call ", "")} reads.`
      : `${words[0].toUpperCase()}${words.slice(1)} (its answer carries guestLoaded); browserAttached stays false for good, so do not call extension_wait again.`;
  }

  if (typeof launch.cdpPort === "number") return `${again} to read the load over the debug port ${launch.cdpPort} once more.`;

  return `${again}: ${debugPortWords(outlook)}.`;
}

export function productionWaitHint(
  contract: ReadyContract,
  launch: ProductionLaunchEvidence,
  session: { projectPath: string; browser: string },
): string {
  const what = contract.command === "preview" ? "a prebuilt dist served by the engine's preview verb" : "the production build";
  const browserSeen = launch.browserPid === null ? "" : ` and names the browser it launched (pid ${launch.browserPid}, ${launch.browserAlive ? "alive" : "gone"})`;
  const loaded = launch.extensionLoaded === true ? `and the browser loaded the extension (${launch.loadEvidence})` : "not that the browser loaded the extension";
  const control =
    typeof contract.controlPort === "number"
      ? `this session carries the control channel (port ${contract.controlPort}), and the extension's background has not connected to it yet, so ${BRIDGE_VERBS} reach it once it does (the contract's executorAttachedAt); extension_logs has no console stream for it.`
      : `a production launch carries no dev bridge, so extension_logs has no console stream for it, and ${BRIDGE_VERBS} need extension_start again with allowControl: true and replace: true.`;

  return `This is an extension_start session (${what}): the contract says the build landed${browserSeen}, ${loaded}: ${control} ${closing(contract, launch, session.projectPath, session.browser)} ${ARTIFACT}`;
}
