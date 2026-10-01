// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CDPClient } from "./cdp";

export type DevToolsPanelOutcome =
  | {
      opened: true;
      devtoolsTargetId: string;
      panelId: string;
      panelTitle: string;
      panelTarget: { targetId: string; url: string } | null;
      panels: string[];
    }
  | {
      opened: false;
      stage: "open" | "frontend" | "panel" | "show";
      reason: string;
      devtoolsTargetId?: string;
      panels?: string[];
    };

type RawTarget = { id: string; type: string; url: string; title?: string };

type EvaluateResponse = {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

/* @invariant The DevTools frontend has no global for its panel registry: on
   Chrome 151 `InspectorView` is undefined on window, and the only reach is the
   ES module the frontend itself loads, `./ui/legacy/legacy.js`, resolved
   against the frontend's own devtools:// url. A dynamic import from
   Runtime.evaluate on the frontend target lands in that module graph, so the
   same InspectorView instance the UI uses answers. Measured 2026-10-01. */
const PANEL_IDS_EXPRESSION =
  "import('./ui/legacy/legacy.js').then((m) => m.InspectorView.InspectorView.instance().tabbedPane.tabIds())";

function showPanelExpression(panelId: string): string {
  return `import('./ui/legacy/legacy.js').then((m) => m.InspectorView.InspectorView.instance().showPanel(${JSON.stringify(panelId)})).then(() => "shown")`;
}

/* @invariant An extension panel's tab id is the extension origin without its
   trailing slash followed by the panel title, as the frontend's extension
   server builds it (`chrome-extension://<id>Live` for a panel titled Live). */
export function panelIdPrefix(extensionId: string): string {
  return `chrome-extension://${extensionId}`;
}

export function panelTitleFromId(panelId: string, extensionId: string): string {
  return panelId.slice(panelIdPrefix(extensionId).length);
}

function isDevToolsFrontend(target: RawTarget): boolean {
  return String(target.url ?? "").startsWith("devtools://");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function openDevToolsPanel(
  port: number,
  options: {
    inspectedTargetId: string;
    extensionId: string;
    devtoolsPageUrl: string;
    panelTitle?: string;
    budgetMs?: number;
    reloadInspected?: boolean;
  },
): Promise<DevToolsPanelOutcome> {
  const budgetMs = options.budgetMs ?? 15_000;
  const cdp = new CDPClient();
  const listTargets = async (): Promise<RawTarget[]> =>
    (await CDPClient.discoverTargets(port)) as RawTarget[];
  try {
    await cdp.connect(await CDPClient.discoverBrowserWsUrl(port));
    const before = new Set(
      (await listTargets().catch(() => [])).filter(isDevToolsFrontend).map((t) => t.id),
    );

    let devtoolsTargetId: string | null = null;
    try {
      const opened = (await cdp.sendCommand("Target.openDevTools", {
        targetId: options.inspectedTargetId,
      })) as { targetId?: string } | undefined;
      if (typeof opened?.targetId === "string") devtoolsTargetId = opened.targetId;
    } catch (error) {
      return {
        opened: false,
        stage: "open",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const deadline = Date.now() + budgetMs;
    while (!devtoolsTargetId && Date.now() < deadline) {
      await sleep(200);
      const fresh = (await listTargets().catch(() => [])).find(
        (t) => isDevToolsFrontend(t) && !before.has(t.id),
      );
      if (fresh) devtoolsTargetId = fresh.id;
    }
    if (!devtoolsTargetId) {
      return {
        opened: false,
        stage: "frontend",
        reason: "Target.openDevTools answered but no devtools:// frontend target appeared",
      };
    }

    const sessionId = await cdp.attachToTarget(devtoolsTargetId);
    /* @invariant Some extensions register their panel only when the page
       reports to them (Preact Devtools creates it once the page's debug hook
       speaks through the content script), which happens on a load that
       starts with DevTools already open. A reload of the inspected tab after
       the frontend is up is that load; it is opt-in because it discards the
       page state under test (ledger entry 42). */
    if (options.reloadInspected) {
      /* @invariant The reload is useful only once the extension's devtools
         page is up and its port to the inspected tab is connected (Preact
         registers its MAIN-world hook on that connection); a reload sent the
         instant the frontend attaches lands before that and the panel never
         comes. So the devtools_page frame is awaited first, then a settle,
         measured at about 3 s after open by the hand driver that works. */
      const frameDeadline = Date.now() + Math.min(5000, budgetMs / 2);
      while (Date.now() < frameDeadline) {
        const frame = (await listTargets().catch(() => [])).find(
          (t) => t.type === "iframe" && String(t.url ?? "").startsWith(options.devtoolsPageUrl),
        );
        if (frame) break;
        await sleep(200);
      }
      await sleep(Math.min(2500, budgetMs / 4));
      try {
        const inspectedSession = await cdp.attachToTarget(options.inspectedTargetId);
        await cdp.sendCommand("Page.reload", {}, inspectedSession);
      } catch {
      }
    }
    const evaluate = async (expression: string): Promise<EvaluateResponse | null> =>
      ((await cdp
        .sendCommand(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        )
        .catch(() => null)) as EvaluateResponse | null);

    const wantedId =
      typeof options.panelTitle === "string" && options.panelTitle
        ? `${panelIdPrefix(options.extensionId)}${options.panelTitle}`
        : null;
    const prefix = panelIdPrefix(options.extensionId);
    let panels: string[] = [];
    let panelId: string | null = null;
    let nudged = false;
    const nudgeAt = Date.now() + Math.min(4000, budgetMs / 2);
    while (!panelId && Date.now() < deadline) {
      const response = await evaluate(PANEL_IDS_EXPRESSION);
      const ids = response?.result?.value;
      if (Array.isArray(ids)) {
        panels = ids.map(String);
        panelId =
          panels.find((id) => (wantedId ? id === wantedId : id.startsWith(prefix))) ?? null;
      }
      if (panelId) break;
      /* @invariant The devtools_page is an iframe inside the frontend, and a
         headless frontend has been seen to leave it idle for seconds before
         its panels.create call lands. Attaching to that frame and evaluating a
         constant costs nothing and has been seen to wake it, so it is done once,
         after a few seconds, and only when the panel is still missing. */
      if (!nudged && Date.now() >= nudgeAt) {
        nudged = true;
        const frame = (await listTargets().catch(() => [])).find(
          (t) => t.type === "iframe" && String(t.url ?? "").startsWith(options.devtoolsPageUrl),
        );
        if (frame) {
          try {
            const frameSession = await cdp.attachToTarget(frame.id);
            await cdp.sendCommand(
              "Runtime.evaluate",
              { expression: "1", returnByValue: true },
              frameSession,
            );
          } catch {
          }
        }
      }
      await sleep(250);
    }
    if (!panelId) {
      return {
        opened: false,
        stage: "panel",
        devtoolsTargetId,
        panels,
        reason: wantedId
          ? `no panel with id ${wantedId} registered within ${budgetMs}ms`
          : `no panel from ${prefix} registered within ${budgetMs}ms`,
      };
    }

    const framesBefore = new Set(
      (await listTargets().catch(() => []))
        .filter((t) => t.type === "iframe" && String(t.url ?? "").startsWith(`${prefix}/`))
        .map((t) => t.id),
    );
    const shown = await evaluate(showPanelExpression(panelId));
    if (!shown || shown.exceptionDetails) {
      return {
        opened: false,
        stage: "show",
        devtoolsTargetId,
        panels,
        reason: `showPanel(${panelId}) ${shown?.exceptionDetails ? `threw: ${shown.exceptionDetails.exception?.description ?? shown.exceptionDetails.text ?? "unknown"}` : "did not answer"}`,
      };
    }

    let panelTarget: { targetId: string; url: string } | null = null;
    const showDeadline = Date.now() + 3000;
    while (!panelTarget && Date.now() < showDeadline) {
      const frames = (await listTargets().catch(() => [])).filter(
        (t) =>
          t.type === "iframe" &&
          String(t.url ?? "").startsWith(`${prefix}/`) &&
          !String(t.url ?? "").startsWith(options.devtoolsPageUrl),
      );
      const fresh = frames.find((t) => !framesBefore.has(t.id)) ?? frames[0];
      if (fresh) panelTarget = { targetId: fresh.id, url: String(fresh.url) };
      else await sleep(200);
    }
    return {
      opened: true,
      devtoolsTargetId,
      panelId,
      panelTitle: panelTitleFromId(panelId, options.extensionId),
      panelTarget,
      panels,
    };
  } catch (error) {
    return {
      opened: false,
      stage: "open",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      cdp.disconnect();
    } catch {
    }
  }
}
