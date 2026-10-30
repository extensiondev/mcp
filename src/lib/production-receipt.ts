// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { envelope } from "./envelope";
import { contractErrorList } from "./wait-modes";
import { pidState } from "./process-identity";
import { liveProjectSessions } from "./session-browser";
import { readyContractPath } from "./session-paths";

import type { ReadyContract } from "./types";

export type ProductionPhase = "starting" | "ready" | "error" | "stopped" | "engine-gone";

export interface ProductionReceipt {
  kind: "production";
  path: string;
  contract: ReadyContract;
  verb: "start" | "preview";
  control: boolean;
  controlPort: number | null;
  cdpPort: number | null;
  attachedAt: string | null;
  phase: ProductionPhase;
}

export type SessionReceipt =
  | { kind: "none"; path: string }
  | { kind: "dev"; path: string; contract: ReadyContract }
  | { kind: "build"; path: string; contract: ReadyContract }
  | ProductionReceipt;

function port(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

function phaseOf(contract: ReadyContract): ProductionPhase {
  if (typeof contract.pid === "number" && pidState(contract.pid) !== "alive") return "engine-gone";
  if (contract.status === "error") return "error";
  if (contract.status === "stopped") return "stopped";

  return contract.status === "ready" ? "ready" : "starting";
}

export function readSessionReceipt(projectPath: string, browser: string): SessionReceipt {
  const path = readyContractPath(projectPath, browser);
  let contract: ReadyContract;

  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return { kind: "none", path };

    contract = parsed as ReadyContract;
  } catch {
    return { kind: "none", path };
  }

  if (contract.command === "build") return { kind: "build", path, contract };
  if (contract.command !== "start" && contract.command !== "preview") return { kind: "dev", path, contract };

  const controlPort = port(contract.controlPort);

  return {
    kind: "production",
    path,
    contract,
    verb: contract.command,
    control: controlPort !== null,
    controlPort,
    cdpPort: port(contract.cdpPort),
    attachedAt: typeof contract.executorAttachedAt === "string" && contract.executorAttachedAt ? contract.executorAttachedAt : null,
    phase: phaseOf(contract),
  };
}

export interface NoSessionWords {
  message: string;
  hint?: string;
}

export function waitCall(projectPath: string, browser: string): string {
  return `extension_wait {projectPath: ${JSON.stringify(projectPath)}, browser: ${JSON.stringify(browser)}}`;
}

const NOT_DEV = "Do not start extension_dev for it: that replaces the production session with a dev session.";

const BRIDGE_VERBS = "extension_storage, extension_reload, extension_open with a surface, extension_dom_snapshot by tab and extension_eval";

function controlNote(receipt: ProductionReceipt): string {
  return receipt.control
    ? ""
    : ` This run was started without allowControl, so once it is up the debug-port reads work while ${BRIDGE_VERBS} need extension_start again with allowControl: true and replace: true.`;
}

function replacingRun(receipt: ProductionReceipt, projectPath: string, browser: string): number | null {
  const live = liveProjectSessions(projectPath).find((session) => session.browser === browser);

  return live && live.pid !== receipt.contract.pid ? live.pid : null;
}

function productionWords(receipt: ProductionReceipt, projectPath: string, browser: string, need: string): NoSessionWords {
  const { contract, path } = receipt;
  const session = `The ${browser} production session (extension_start)`;
  const again = receipt.control ? "extension_start again with allowControl: true" : "extension_start again";

  switch (receipt.phase) {
    case "engine-gone": {
      const replacing = replacingRun(receipt, projectPath, browser);

      if (replacing !== null) {
        return {
          message: `${session} is being replaced: the run that wrote ${path} (pid ${contract.pid}) has ended and the new extension_start run (pid ${replacing}) has not written its receipt yet, ${need}.`,
          hint: `Call ${waitCall(projectPath, browser)}, then this call again. ${NOT_DEV}`,
        };
      }

      return {
        message: `${session} has ended: its engine process (pid ${contract.pid}) is gone, so ${path} describes a run nothing listens for, ${need}.`,
        hint: `Call extension_stop to clean up, then ${again}.`,
      };
    }

    case "error": {
      const errors = contractErrorList(contract);

      return {
        message: `${session} has no browser to drive: its build failed${errors.length ? ` (${errors.join("; ")})` : ""}, ${need}.`,
        hint: `Fix the build error, then call ${again}.`,
      };
    }

    case "stopped":
      return {
        message: `${session} was stopped (${path} reads status: stopped), ${need}.`,
        hint: `Call ${again}.`,
      };
    default:
      break;
  }

  const browserPid = typeof contract.browserPid === "number" && contract.browserPid > 0 ? contract.browserPid : null;

  if (receipt.phase === "ready" && (browserPid !== null || receipt.attachedAt)) {
    return {
      message: `${session} names no debug port yet: ${path} reads status ready${browserPid !== null ? ` and the browser it launched (pid ${browserPid})` : ""}${receipt.attachedAt ? `, with the background attached at ${receipt.attachedAt}` : ""}, but no cdpPort, ${need}.`,
      hint: `Call ${waitCall(projectPath, browser)}, then this call again: the engine stamps cdpPort once the browser binds its debug port, and an engine that opens none on a production run (before Extension.js 4.1.36) never will.${controlNote(receipt)} ${NOT_DEV}`,
    };
  }

  return {
    message: `${session} is still starting: ${path} reads status ${contract.status}${receipt.phase === "ready" ? " and no browser launch yet" : ""}, ${need}.`,
    hint: `Call ${waitCall(projectPath, browser)}, then this call again.${controlNote(receipt)} ${NOT_DEV}`,
  };
}

export function noSessionWords(
  projectPath: string,
  browser: string,
  dev: NoSessionWords,
  need = "so there is no browser to ask yet",
): NoSessionWords {
  const receipt = readSessionReceipt(projectPath, browser);

  if (receipt.kind === "production") return productionWords(receipt, projectPath, browser, need);

  if (receipt.kind === "build") {
    return {
      message: `${receipt.path} is the receipt of a finished extension_build (command: build), not a running session, ${need}.`,
      hint: "Start a session first: extension_dev for the dev loop, or extension_start with allowControl: true to drive the production build; then extension_wait for ready.",
    };
  }

  return dev;
}

export function noSessionEnvelope(input: {
  command: string;
  projectPath: string;
  browser: string;
  need: string;
  dev: NoSessionWords;
  name?: string;
}): string {
  const words = noSessionWords(input.projectPath, input.browser, input.dev, input.need);

  return envelope({
    ok: false,
    command: input.command,
    status: "no-session",
    error: {
      code: "E_NO_SESSION",
      ...(input.name ? { name: input.name } : {}),
      message: words.message,
    },
    ...(words.hint ? { hint: words.hint } : {}),
  });
}

export function productionSessionContext(projectPath: string, browser: string): string | null {
  const receipt = readSessionReceipt(projectPath, browser);
  if (receipt.kind !== "production") return null;
  if (receipt.phase === "ready" && receipt.control && (receipt.cdpPort !== null || receipt.attachedAt)) return null;

  const words = productionWords(receipt, projectPath, browser, "so the control verbs cannot reach it");

  return `${words.message}${words.hint ? ` ${words.hint}` : ""}`;
}
