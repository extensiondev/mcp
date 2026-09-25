// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CDPClient } from "./cdp";
import { listPageTargets, type PageTarget } from "./cdp-targets";

/* @invariant Chrome's MV3 extension CSP governs scripts the page runs, and
   chrome.scripting cannot inject into another extension's origin at all, so
   neither the in-bundle relay nor a tab injection can evaluate a string in an
   extension page. The inspector can: Runtime.evaluate on the page's own target
   is the DevTools console path, which the page CSP does not see, and the dev
   session already publishes the debug port it needs. Everything here speaks to
   an extension page over that port and nothing else. */

const RUNTIME_EVALUATE_DEFAULTS = {
  returnByValue: true,
  awaitPromise: true,
  userGesture: true,
};

type RemoteObject = {
  type?: string;
  subtype?: string;
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
  | { ok: true; value: unknown }
  | { ok: false; message: string; thrown: boolean };

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

export async function findExtensionPageTargets(
  port: number,
  wantedUrl: string,
): Promise<PageTarget[]> {
  try {
    return matchExtensionPageTargets(await listPageTargets(port), wantedUrl);
  } catch {
    return [];
  }
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

export async function evaluateOnExtensionPage(
  port: number,
  targetId: string,
  expression: string,
): Promise<ExtensionPageEval> {
  const cdp = new CDPClient();
  try {
    await cdp.connect(await CDPClient.discoverBrowserWsUrl(port));
    const sessionId = await cdp.attachToTarget(targetId);
    const response = (await cdp.sendCommand(
      "Runtime.evaluate",
      { expression, ...RUNTIME_EVALUATE_DEFAULTS },
      sessionId,
    )) as EvaluateResponse | undefined;
    if (response?.exceptionDetails) {
      return {
        ok: false,
        thrown: true,
        message: describeException(response.exceptionDetails),
      };
    }
    return { ok: true, value: readRemoteValue(response?.result) };
  } catch (error) {
    return {
      ok: false,
      thrown: false,
      message: error instanceof Error ? error.message : String(error),
    };
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
          (t) => t.targetId !== excluded,
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
