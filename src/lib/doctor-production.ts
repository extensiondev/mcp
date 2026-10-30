// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { BridgeController, readControlToken } from "extension-develop/bridge";

import { isChromiumFamily, isGeckoFamily } from "./browser-family";
import { CDPClient } from "./cdp";
import { describeForeignPid, pidState } from "./process-identity";
import { waitCall } from "./production-receipt";
import { engineProjectRoot } from "./session-paths";

import type { ProductionReceipt } from "./production-receipt";

export interface DoctorLeg {
  check: string;
  status: "pass" | "warn" | "fail" | "skip";
  detail: string;
  remediation?: string;
}

const CONNECT_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const ATTACH_GRACE_MS = 15_000;

export const ENGINE_SESSION_LEGS = new Set([
  "ready-contract",
  "server-process",
  "port-agreement",
  "control-channel",
  "eval-token",
  "executor",
  "browser",
]);

const RESTART = "Call extension_stop to clean up, then extension_start again (allowControl: true for the control verbs).";

function describe(err: unknown): string {
  return String((err as Error | undefined)?.message || err);
}

function stampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;

  const ms = Date.parse(value);

  return Number.isFinite(ms) ? ms : null;
}

function withinAttachGrace(receipt: ProductionReceipt): boolean {
  const since = stampMs(receipt.contract.ts) ?? stampMs(receipt.contract.compiledAt) ?? stampMs(receipt.contract.startedAt);

  return since !== null && Date.now() - since < ATTACH_GRACE_MS;
}

function readyContractLeg(receipt: ProductionReceipt, projectPath: string, browser: string): DoctorLeg {
  const { contract, verb } = receipt;
  const session = `production session (extension_start, engine verb ${verb})`;

  switch (contract.status) {
    case "ready":
      return {
        check: "ready-contract",
        status: "pass",
        detail: `${session}: status ready, ${
          receipt.control
            ? `controlPort ${receipt.controlPort}, instanceId ${contract.instanceId ?? "unset"}`
            : "no control channel (started without allowControl)"
        }${contract.ts ? `, written ${contract.ts}` : ""}`,
      };
    case "error":
      return {
        check: "ready-contract",
        status: "fail",
        detail: `${session}: contract status is 'error', the build failed${contract.message ? `: ${contract.message}` : ""}`,
        remediation: "Fix the build error, then call extension_start again; ready.json `errors` carries the full text.",
      };
    case "stopped":
      return {
        check: "ready-contract",
        status: "fail",
        detail: `${session}: contract status is 'stopped', the session ended`,
        remediation: "Call extension_start again.",
      };
    default:
      return {
        check: "ready-contract",
        status: "fail",
        detail: `${session}: contract status is '${contract.status ?? "unknown"}', the build or the browser launch has not landed yet`,
        remediation: `Wait for it: ${waitCall(projectPath, browser)}. Do not start extension_dev, which replaces this production session.`,
      };
  }
}

function serverProcessLeg(receipt: ProductionReceipt): DoctorLeg {
  const pid = receipt.contract.pid;

  if (typeof pid !== "number") {
    return { check: "server-process", status: "skip", detail: "skipped: the contract has no pid, so the engine process cannot be checked" };
  }

  const state = pidState(pid);

  if (state === "alive") {
    return { check: "server-process", status: "pass", detail: `engine process pid ${pid} (extension ${receipt.verb}) is alive` };
  }

  return {
    check: "server-process",
    status: "fail",
    detail:
      state === "dead"
        ? `engine process pid ${pid} is gone, ready.json describes a production run that ended`
        : `${describeForeignPid(pid)}; ready.json no longer names a live production run`,
    remediation: RESTART,
  };
}

function portAgreementLeg(receipt: ProductionReceipt): DoctorLeg {
  return {
    check: "port-agreement",
    status: "skip",
    detail: receipt.control
      ? "skipped: a production run picks a fresh control port each time and persists none; the controlled copy carries the port in extension-js-control.json, so there is no persisted port to agree with"
      : "skipped: no control channel, so there is no control port to agree on",
  };
}

function skipped(check: string, blockedBy: string): DoctorLeg {
  return { check, status: "skip", detail: `skipped: blocked by ${blockedBy}` };
}

function noControlLegs(): DoctorLeg[] {
  return [
    {
      check: "control-channel",
      status: "skip",
      detail: "skipped: this production session was started without allowControl, so it carries no control channel; extension_storage, extension_reload, extension_open with a surface, extension_dom_snapshot by tab and extension_eval need extension_start with allowControl: true (allowEval: true for extension_eval)",
    },
    skipped("eval-token", "control-channel"),
    skipped("executor", "control-channel"),
  ];
}

function controlRefusal(message: string): DoctorLeg {
  const code = /code (\d+)/.exec(message)?.[1];

  if (code === "4001") {
    return {
      check: "control-channel",
      status: "fail",
      detail: "refused: ready.json instanceId no longer matches the live control server",
      remediation: "A newer run overwrote the contract, or this dist belongs to another run; re-read ready.json or call extension_stop, then extension_start again.",
    };
  }

  if (code === "4003") {
    return {
      check: "control-channel",
      status: "fail",
      detail: "refused: control is off in the production run that answered",
      remediation: "Call extension_start again with allowControl: true and replace: true.",
    };
  }

  return {
    check: "control-channel",
    status: "fail",
    detail: message,
    remediation: "The control server did not answer on the contract port; the run may have died or the port was taken. Call extension_stop, then extension_start again with allowControl: true.",
  };
}

function evalTokenLeg(evalOn: boolean, token: string | undefined): DoctorLeg {
  if (!evalOn) return { check: "eval-token", status: "pass", detail: "eval disabled (allowEval not set), nothing to verify" };

  return token
    ? { check: "eval-token", status: "pass", detail: "eval enabled and the session token is readable" }
    : {
        check: "eval-token",
        status: "fail",
        detail: "eval is enabled but no session token could be read under .extension-js/",
        remediation: "Run from the same project root the production run was started in, or call extension_start again with allowEval: true to rewrite the token.",
      };
}

async function executorLeg(controller: BridgeController, receipt: ProductionReceipt): Promise<DoctorLeg> {
  try {
    const probe = await controller.command({ op: "storage.get", target: { context: "background" }, args: { area: "local" }, timeoutMs: PROBE_TIMEOUT_MS });
    const unanswered = !probe.ok && (probe.error?.name === "Unavailable" || probe.error?.name === "Timeout");

    if (!unanswered) {
      return {
        check: "executor",
        status: "pass",
        detail: probe.ok
          ? "executor responded to a storage probe"
          : `executor responded (probe errored in-extension: ${probe.error?.message ?? "unknown"})`,
      };
    }

    if (probe.error?.name === "Timeout") {
      return {
        check: "executor",
        status: "fail",
        detail: `executor did not answer a storage probe within ${PROBE_TIMEOUT_MS / 1000}s; the background is connected but not responding`,
        remediation: "Call extension_reload, or extension_stop and extension_start again if it stays silent.",
      };
    }

    if (withinAttachGrace(receipt)) {
      return {
        check: "executor",
        status: "warn",
        detail: `no executor connected yet: the browser is still launching (within ${ATTACH_GRACE_MS / 1000}s of the contract), so the background has not attached to the control channel`,
        remediation: "Give it a moment: extension_wait reads the contract's executorAttachedAt, or call extension_doctor again shortly.",
      };
    }

    return {
      check: "executor",
      status: "fail",
      detail: probe.error?.message ?? "no executor connected",
      remediation: "The message above names the likely cause; retry shortly, then extension_reload, or extension_stop and extension_start again.",
    };
  } catch (err) {
    return {
      check: "executor",
      status: "fail",
      detail: `probe did not complete: ${describe(err)}`,
      remediation: "Retry shortly; if it persists, extension_reload, or extension_stop and extension_start again.",
    };
  }
}

async function controlLegs(projectPath: string, browser: string, receipt: ProductionReceipt): Promise<DoctorLeg[]> {
  if (!receipt.control) return noControlLegs();

  const token = readControlToken(engineProjectRoot(projectPath), browser) ?? undefined;
  const controller = new BridgeController({
    controlPort: receipt.controlPort as number,
    instanceId: receipt.contract.instanceId ?? "",
    token,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
  });

  try {
    let frame: Awaited<ReturnType<BridgeController["connect"]>>;

    try {
      frame = await controller.connect();
    } catch (err) {
      return [controlRefusal(describe(err)), skipped("eval-token", "control-channel"), skipped("executor", "control-channel")];
    }

    return [
      { check: "control-channel", status: "pass", detail: `connected, capabilities: ${JSON.stringify(frame?.capabilities ?? {})}` },
      evalTokenLeg(Boolean(frame?.capabilities?.eval), token),
      await executorLeg(controller, receipt),
    ];
  } finally {
    controller.close();
  }
}

function browserLeg(receipt: ProductionReceipt): DoctorLeg {
  const { contract } = receipt;
  const binary = typeof contract.binary === "string" && contract.binary ? ` (${contract.binary})` : "";

  if (contract.browserExitedAt) {
    return {
      check: "browser",
      status: "fail",
      detail: `browser exited at ${contract.browserExitedAt}${contract.browserExitCode != null ? ` (code ${contract.browserExitCode})` : ""} while the engine process kept running${binary}`,
      remediation: RESTART,
    };
  }

  if (typeof contract.browserPid !== "number" || contract.browserPid <= 0) {
    return { check: "browser", status: "skip", detail: "skipped: the contract has not recorded a browser launch yet (no browserPid); extension_wait reads it once the build and the launch land" };
  }

  const state = pidState(contract.browserPid);

  return state === "alive"
    ? { check: "browser", status: "pass", detail: `browser pid ${contract.browserPid} is alive${binary}` }
    : {
        check: "browser",
        status: "fail",
        detail: state === "dead" ? `browser pid ${contract.browserPid} is gone${binary}` : `${describeForeignPid(contract.browserPid)}; the browser this run launched is gone`,
        remediation: RESTART,
      };
}

async function debugPortLeg(browser: string, receipt: ProductionReceipt): Promise<DoctorLeg> {
  if (!isChromiumFamily(browser)) {
    return {
      check: "debug-port",
      status: "skip",
      detail: `skipped: ${isGeckoFamily(browser) ? "Firefox" : "Safari"} sessions open no Chromium debug port, so this leg has nothing to dial`,
    };
  }

  if (receipt.cdpPort === null) {
    return {
      check: "debug-port",
      status: "skip",
      detail: "skipped: the receipt names no cdpPort yet, so extension_open by url, extension_screenshot, the targetId reads and the capabilities read have nothing to dial; the engine stamps it once the browser binds its debug port (Extension.js 4.1.34 or later opens one on a production run)",
    };
  }

  try {
    const version = await CDPClient.discoverBrowserVersion(receipt.cdpPort);

    return { check: "debug-port", status: "pass", detail: `debug port ${receipt.cdpPort} answers${version ? ` (${version})` : ""}` };
  } catch (err) {
    return {
      check: "debug-port",
      status: "fail",
      detail: `debug port ${receipt.cdpPort} did not answer: ${describe(err)}`,
      remediation: "The browser is gone or another process took the port; extension_stop, then extension_start again.",
    };
  }
}

export async function productionSessionChecks(projectPath: string, browser: string, receipt: ProductionReceipt): Promise<DoctorLeg[]> {
  const ready = readyContractLeg(receipt, projectPath, browser);
  const server = serverProcessLeg(receipt);
  const live = ready.status === "pass" && server.status === "pass";
  const control = live
    ? await controlLegs(projectPath, browser, receipt)
    : [skipped("control-channel", ready.status === "pass" ? "server-process" : "ready-contract"), skipped("eval-token", "control-channel"), skipped("executor", "control-channel")];

  return [ready, server, portAgreementLeg(receipt), ...control, browserLeg(receipt), await debugPortLeg(browser, receipt)];
}

export function spliceProductionLegs<T extends { check: string }>(engineChecks: T[], production: DoctorLeg[]): Array<T | DoctorLeg> {
  const at = engineChecks.findIndex((leg) => leg.check === "ready-contract");
  const kept = engineChecks.filter((leg) => !ENGINE_SESSION_LEGS.has(leg.check));
  const before = at === -1 ? kept : kept.filter((leg) => engineChecks.indexOf(leg) < at);
  const after = at === -1 ? [] : kept.filter((leg) => engineChecks.indexOf(leg) > at);

  return [...before, ...production, ...after];
}

export function productionDoctorHint(receipt: ProductionReceipt): string {
  return receipt.control
    ? "This is a production session (extension_start with allowControl): the checks read the engine process, the control channel on the controlled copy of the build, its executor, the browser and its debug port. extension_logs has no console stream for it, and the port-agreement leg has nothing to compare on a production run."
    : "This is a production session (extension_start without allowControl): the checks read the build receipt, the engine process, the browser and its debug port. The bridge verbs (extension_storage, extension_reload, extension_open with a surface, extension_dom_snapshot by tab, extension_eval) need extension_start again with allowControl: true and replace: true; this is not a dev session to restart.";
}
