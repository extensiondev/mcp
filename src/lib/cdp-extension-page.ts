// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CDPClient } from "./cdp";
import { listDocumentTargets, type PageTarget } from "./cdp-targets";

/* @invariant Chrome's MV3 extension CSP governs scripts the page runs, and
   chrome.scripting cannot inject into another extension's origin at all, so
   neither the in-bundle relay nor a tab injection can evaluate a string in an
   extension page. The inspector can: Runtime.evaluate on the page's own target
   is the DevTools console path, which the page CSP does not see, and the dev
   session already publishes the debug port it needs. Everything here speaks to
   an extension page over that port and nothing else. */

/* @invariant replMode is what lets a bare top-level `await` parse, the way the
   DevTools console accepts it; without it Runtime.evaluate answers
   "await is only valid in async functions", measured on Chrome 151. It is NOT
   in the defaults: with replMode on, Chrome 151 answers a promise-valued
   expression with the promise object itself and ignores awaitPromise, on
   pages and workers alike, so every promise serialized to {}. evaluateOnExtensionPage turns it on only for the retry an await needs. */
const RUNTIME_EVALUATE_DEFAULTS = {
  returnByValue: true,
  awaitPromise: true,
  userGesture: true,
};

type RemoteObject = {
  type?: string;
  subtype?: string;
  objectId?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
};

type EvaluateResponse = {
  result?: RemoteObject;
  exceptionDetails?: {
    text?: string;
    exception?: RemoteObject;
  };
};

export type ExtensionPageEval =
  | { ok: true; value: unknown; note?: string }
  | { ok: false; message: string; thrown: boolean; timedOut?: boolean };

function stripHash(url: string): string {
  return url.replace(/#.*$/, "");
}

export function matchExtensionPageTargets(
  targets: PageTarget[],
  wantedUrl: string,
): PageTarget[] {
  const wanted = stripHash(wantedUrl);
  return targets.filter((t) => {
    const url = stripHash(t.url);
    return url === wanted || url.startsWith(wanted);
  });
}

export const WORKER_TARGET_TYPES = new Set([
  "service_worker",
  "background_page",
  "worker",
]);

/* @invariant A DEDICATED WORKER IS NOT THE BACKGROUND: it has no chrome.*
   and lives beside an idle service worker, so taking the first listed
   worker ran the expression there with no wake attempted. */
export const BACKGROUND_TARGET_TYPES = new Set(["service_worker", "background_page"]);

/* @invariant The background has no page target: an MV3 service worker and an
   MV2 background page are targets of their own types, and Runtime.evaluate on
   them is the inspector path the extension CSP does not govern, the same way
   it is for the extension's pages. */
/* @invariant A LIST THAT COULD NOT BE READ IS NOT AN EMPTY LIST. These used
   to answer `[]` when the target fetch threw, and the callers told the agent
   "no open page" or the idle-worker story. */
export type TargetsRead<T> = { targets: T[] } | { unreadable: string };

export async function readExtensionWorkerTargets(
  port: number,
  extensionId: string,
): Promise<TargetsRead<{ targetId: string; type: string; url: string }>> {
  try {
    const origin = `chrome-extension://${extensionId}/`;
    return {
      targets: (await CDPClient.discoverTargets(port))
        .filter(
          (t) =>
            WORKER_TARGET_TYPES.has(String(t.type)) &&
            String(t.url ?? "").startsWith(origin),
        )
        .map((t) => ({ targetId: String(t.id), type: String(t.type), url: String(t.url ?? "") })),
    };
  } catch (err) {
    return { unreadable: err instanceof Error ? err.message : String(err) };
  }
}

export async function findExtensionWorkerTargets(
  port: number,
  extensionId: string,
): Promise<Array<{ targetId: string; type: string; url: string }>> {
  const read = await readExtensionWorkerTargets(port, extensionId);
  return "targets" in read ? read.targets : [];
}

export type WorkerWake =
  | { woken: true; targets: Array<{ targetId: string; type: string; url: string }> }
  | { woken: false; reason: string };

/* @invariant An idle MV3 worker is the normal state of an extension, not a
   fault: Chrome stops it after about 30 s without events and lists no target
   for it. The ServiceWorker domain is not on the browser session, but any
   page session carries it, and ServiceWorker.startWorker on the extension's
   scope brings the worker back and relists it, measured on Chrome 151
  . The page the command is issued from is incidental; an
   extension page is preferred only because it certainly exists in the same
   profile. */
export async function wakeExtensionWorker(
  port: number,
  extensionId: string,
): Promise<WorkerWake> {
  const cdp = new CDPClient();
  const scopeURL = `chrome-extension://${extensionId}/`;
  try {
    await cdp.connect(await CDPClient.discoverBrowserWsUrl(port));
    const pages = (await CDPClient.discoverTargets(port)).filter(
      (t) => t.type === "page" && !String(t.url ?? "").startsWith("devtools://"),
    );
    const host =
      pages.find((t) => String(t.url ?? "").startsWith(scopeURL)) ?? pages[0];
    if (!host) {
      return {
        woken: false,
        reason: "the session has no page target to issue ServiceWorker.startWorker from",
      };
    }
    const sessionId = await cdp.attachToTarget(String(host.id));
    await cdp.sendCommand("ServiceWorker.enable", {}, sessionId);
    await cdp.sendCommand("ServiceWorker.startWorker", { scopeURL }, sessionId);
    const deadline = Date.now() + 3000;
    for (;;) {
      const targets = await findExtensionWorkerTargets(port, extensionId);
      if (targets.length > 0) return { woken: true, targets };
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return {
      woken: false,
      reason:
        "ServiceWorker.startWorker answered but no worker target was listed within 3s (the extension may declare no background, or the worker exited at once)",
    };
  } catch (error) {
    return {
      woken: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      cdp.disconnect();
    } catch {
    }
  }
}

export async function readExtensionPageTargets(
  port: number,
  wantedUrl: string,
): Promise<TargetsRead<PageTarget>> {
  try {
    return { targets: matchExtensionPageTargets(await listDocumentTargets(port), wantedUrl) };
  } catch (err) {
    return { unreadable: err instanceof Error ? err.message : String(err) };
  }
}

export async function findExtensionPageTargets(
  port: number,
  wantedUrl: string,
): Promise<PageTarget[]> {
  const read = await readExtensionPageTargets(port, wantedUrl);
  return "targets" in read ? read.targets : [];
}

/* @invariant A VALUE JSON CANNOT CARRY IS SAID, NOT PASSED OFF. NaN,
   Infinity, -0 and BigInt come back from the protocol as strings in
   unserializableValue, and undefined comes back as null; the caller sees the
   converted value with a note naming the conversion. */
export function remoteValueNote(result: RemoteObject | undefined): string | undefined {
  if (!result) return undefined;
  if (result.type === "undefined") return "the expression returned undefined, which is answered as null";
  if (typeof result.unserializableValue === "string") {
    return `the expression returned ${result.unserializableValue}${result.type === "bigint" ? " (a BigInt)" : ""}, which JSON cannot carry, so value holds it as the string "${result.unserializableValue}"`;
  }
  return undefined;
}

function readRemoteValue(result: RemoteObject | undefined): unknown {
  if (!result) return null;
  if ("value" in result) return result.value;
  if (result.type === "undefined") return null;
  if (typeof result.unserializableValue === "string") {
    return result.unserializableValue;
  }
  return result.description ?? null;
}

function describeException(
  details: EvaluateResponse["exceptionDetails"],
): string {
  const exception = details?.exception;
  if (typeof exception?.description === "string" && exception.description) {
    return exception.description.split("\n")[0];
  }
  if (exception && "value" in exception) return String(exception.value);
  return details?.text || "the expression threw";
}

const TOP_LEVEL_AWAIT_REFUSAL = /await is only valid in async functions/i;

/* @invariant Two calls are the honest shape. The first evaluate runs without
   replMode, so awaitPromise settles a promise-valued expression and
   returnByValue serializes the result. Only when Chrome refuses the parse for
   a top-level await is the expression re-run in replMode, with the promise
   handed back by reference and settled through Runtime.awaitPromise, the one
   call that awaits a replMode result honestly. Measured on Chrome 151 on a
   page, a DevTools iframe and a service worker. */
/* @invariant THE CALLER'S TIMEOUT IS THE EVALUATE'S TIMEOUT. The connection's
   fixed 15 s used to cut an expression the caller gave 60 s, and the answer
   blamed the debug port while the expression ran on, so a retry did its
   side effect twice. A timed-out evaluate is answered as
   such. */
export async function evaluateOnExtensionPage(
  port: number,
  targetId: string,
  expression: string,
  timeoutMs?: number,
): Promise<ExtensionPageEval> {
  const cdp = new CDPClient();
  const budget = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : undefined;
  try {
    await cdp.connect(await CDPClient.discoverBrowserWsUrl(port));
    const sessionId = await cdp.attachToTarget(targetId);
    let response = (await cdp.sendCommand(
      "Runtime.evaluate",
      { expression, ...RUNTIME_EVALUATE_DEFAULTS },
      sessionId,
      budget,
    )) as EvaluateResponse | undefined;
    if (
      response?.exceptionDetails &&
      TOP_LEVEL_AWAIT_REFUSAL.test(describeException(response.exceptionDetails))
    ) {
      const asPromise = (await cdp.sendCommand(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: false,
          awaitPromise: false,
          userGesture: true,
          replMode: true,
        },
        sessionId,
        budget,
      )) as EvaluateResponse | undefined;
      const promiseObjectId = asPromise?.result?.objectId;
      response =
        !asPromise?.exceptionDetails && typeof promiseObjectId === "string"
          ? ((await cdp.sendCommand(
              "Runtime.awaitPromise",
              { promiseObjectId, returnByValue: true },
              sessionId,
              budget,
            )) as EvaluateResponse | undefined)
          : asPromise;
    }
    if (response?.exceptionDetails) {
      return {
        ok: false,
        thrown: true,
        message: describeException(response.exceptionDetails),
      };
    }
    const note = remoteValueNote(response?.result);
    return { ok: true, value: readRemoteValue(response?.result), ...(note ? { note } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message)) {
      return {
        ok: false,
        thrown: false,
        timedOut: true,
        message: `The expression did not answer within ${budget ?? 15_000} ms over the debug port. It may still be running in the target, so a retry repeats whatever it does; read the target's state first, or pass a larger timeout.`,
      };
    }
    return { ok: false, thrown: false, message };
  } finally {
    try {
      cdp.disconnect();
    } catch {
    }
  }
}

export type SidePanelGestureOutcome =
  | { opened: true; targetId: string; url: string }
  | { opened: false; reason: string };

const SIDE_PANEL_API_READY =
  'typeof chrome !== "undefined" && typeof chrome.sidePanel !== "undefined" && typeof chrome.windows !== "undefined" && document.readyState !== "loading"';

const SIDE_PANEL_STATE = "window.__extensionDevSidePanel";

/* @invariant The click is what carries the gesture, not the evaluate. A
   trusted Input.dispatchMouseEvent lands in the page as a real click with
   transient user activation, the same activation a toolbar click would carry,
   and chrome.sidePanel.open called from inside that click handler passes
   Chrome's gesture check. The handler lives on an overlay that covers the
   viewport and stops propagation, so the click reaches nothing the extension
   itself listens to; the overlay removes itself once the call settles. */
const ARM_SIDE_PANEL_SCRIPT = `(async () => {
  const win = await chrome.windows.getCurrent();
  const state = { phase: "armed", windowId: win.id };
  ${SIDE_PANEL_STATE} = state;
  const overlay = document.createElement("div");
  overlay.setAttribute("data-extension-dev-gesture", "");
  overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:transparent;cursor:default;";
  overlay.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    state.phase = "clicked";
    const settle = (phase, message) => {
      state.phase = phase;
      if (message) state.message = message;
      overlay.remove();
    };
    try {
      Promise.resolve(chrome.sidePanel.open({ windowId: win.id }))
        .then(() => settle("opened"))
        .catch((error) => settle("failed", String((error && error.message) || error)));
    } catch (error) {
      settle("failed", String((error && error.message) || error));
    }
  }, { once: true });
  document.documentElement.appendChild(overlay);
  return win.id;
})()`;

const READ_SIDE_PANEL_STATE = `(() => {
  const state = ${SIDE_PANEL_STATE};
  return state ? { phase: state.phase, message: state.message } : null;
})()`;

async function pollUntil<T>(
  read: () => Promise<T | null>,
  budgetMs: number,
  everyMs: number,
): Promise<T | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export async function openSidePanelWithSyntheticGesture(
  port: number,
  hostUrl: string,
  excludeTargetIds: ReadonlySet<string> = new Set(),
): Promise<SidePanelGestureOutcome> {
  const cdp = new CDPClient();
  let hostId: string | null = null;
  const closeHost = async (): Promise<void> => {
    if (!hostId) return;
    try {
      await cdp.sendCommand("Target.closeTarget", { targetId: hostId });
    } catch {
    }
  };
  try {
    await cdp.connect(await CDPClient.discoverBrowserWsUrl(port));
    const created = (await cdp.sendCommand("Target.createTarget", {
      url: hostUrl,
    })) as { targetId?: string } | undefined;
    if (typeof created?.targetId !== "string") {
      return {
        opened: false,
        reason: `the browser did not open a host tab for ${hostUrl}`,
      };
    }
    hostId = created.targetId;
    const sessionId = await cdp.attachToTarget(hostId);
    await cdp.sendCommand("Runtime.enable", {}, sessionId);

    const evaluate = async (expression: string): Promise<EvaluateResponse> =>
      (await cdp.sendCommand(
        "Runtime.evaluate",
        { expression, ...RUNTIME_EVALUATE_DEFAULTS },
        sessionId,
      )) as EvaluateResponse;

    const apiReady = await pollUntil(
      async () => {
        const response = await evaluate(SIDE_PANEL_API_READY).catch(() => null);
        return response?.result?.value === true ? true : null;
      },
      5000,
      200,
    );
    if (!apiReady) {
      await closeHost();
      return {
        opened: false,
        reason:
          "chrome.sidePanel is not available in the extension's own page (the manifest needs the sidePanel permission and the page must load)",
      };
    }

    const armed = await evaluate(ARM_SIDE_PANEL_SCRIPT);
    if (armed.exceptionDetails) {
      await closeHost();
      return {
        opened: false,
        reason: `arming the gesture listener threw: ${describeException(armed.exceptionDetails)}`,
      };
    }

    const point = { x: 10, y: 10 };
    await cdp.sendCommand(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", ...point },
      sessionId,
    );
    await cdp.sendCommand(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", button: "left", clickCount: 1, ...point },
      sessionId,
    );
    await cdp.sendCommand(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", button: "left", clickCount: 1, ...point },
      sessionId,
    );

    const settled = await pollUntil(
      async () => {
        const response = await evaluate(READ_SIDE_PANEL_STATE).catch(() => null);
        const state = response?.result?.value as
          | { phase?: string; message?: string }
          | null
          | undefined;
        if (state?.phase === "opened" || state?.phase === "failed") return state;
        return null;
      },
      3000,
      100,
    );
    await closeHost();
    if (!settled) {
      return {
        opened: false,
        reason:
          "the synthetic click never reached chrome.sidePanel.open (the page did not report a result within 3s)",
      };
    }
    if (settled.phase === "failed") {
      return {
        opened: false,
        reason: `chrome.sidePanel.open rejected: ${settled.message ?? "no message"}`,
      };
    }

    const excluded = hostId;
    const panel = await pollUntil(
      async () => {
        const matches = (await findExtensionPageTargets(port, hostUrl)).filter(
          (t) => t.targetId !== excluded && !excludeTargetIds.has(t.targetId),
        );
        return matches.length ? matches[0] : null;
      },
      3000,
      250,
    );
    if (!panel) {
      return {
        opened: false,
        reason: `chrome.sidePanel.open resolved but no page target for ${hostUrl} appeared within 3s`,
      };
    }
    return { opened: true, targetId: panel.targetId, url: panel.url };
  } catch (error) {
    await closeHost();
    return {
      opened: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      cdp.disconnect();
    } catch {
    }
  }
}
