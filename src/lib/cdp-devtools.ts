// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { setTimeout as sleep } from "node:timers/promises";

import { CDPClient } from "./cdp";

export type DevToolsPanelOutcome =
  | {
      opened: true;
      devtoolsTargetId: string;
      panelId: string;
      panelTitle: string;
      panelTarget: { targetId: string; url: string } | null;
      panelTargetInferred?: boolean;
      panelFrameCandidates?: number;
      panels: string[];
      reloadedInspected: boolean;
    }
  | {
      opened: false;
      stage: "open" | "frontend" | "panel" | "show";
      reason: string;
      devtoolsTargetId?: string;
      panels?: string[];
      registryUnreadable?: string;
      devtoolsPageLoaded?: boolean;
    };

type RawTarget = { id: string; type: string; url: string; title?: string };

type EvaluateResponse = {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

/* @invariant The DevTools frontend has no global for its panel registry: on
   Chrome 151 `InspectorView` is undefined on window, and the only reach is
   the ES module the frontend itself loads, `./ui/legacy/legacy.js`, resolved
   against the frontend's own devtools:// url. A dynamic import from
   Runtime.evaluate on the frontend target lands in that module graph, so the
   same InspectorView instance the UI uses answers. Measured on. */
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
  let reloadedInspected = false;
  const budgetMs = options.budgetMs ?? 15_000;
  const cdp = new CDPClient();
  const listTargets = async (): Promise<RawTarget[]> =>
    (await CDPClient.discoverTargets(port)) as RawTarget[];
  let reached: "open" | "frontend" | "panel" | "show" = "open";

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

    reached = "frontend";
    const sessionId = await cdp.attachToTarget(devtoolsTargetId);

    if (options.reloadInspected) {
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
        reloadedInspected = true;
      } catch {
        reloadedInspected = false;
      }
    }

    let lastEvaluateError: string | null = null;
    const evaluate = async (expression: string): Promise<EvaluateResponse | null> =>
      ((await cdp
        .sendCommand(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        )
        .catch((err: unknown) => {
          lastEvaluateError = err instanceof Error ? err.message : String(err);

          return null;
        })) as EvaluateResponse | null);
    /* @invariant A REGISTRY THAT COULD NOT BE READ IS NOT AN EMPTY ONE. The
       devtools_page frame is checked on the way too. */
    let registryAnswered = false;
    let registryError: string | null = null;
    let devtoolsPageLoaded = false;

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

      if (response?.exceptionDetails) {
        registryError = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "the registry read threw";
      } else if (!response) {
        registryError = lastEvaluateError ?? "the registry read did not answer";
      }

      if (!devtoolsPageLoaded) {
        devtoolsPageLoaded = (await listTargets().catch(() => [])).some(
          (t) => t.type === "iframe" && String(t.url ?? "").startsWith(options.devtoolsPageUrl),
        );
      }

      if (Array.isArray(ids)) {
        registryAnswered = true;
        panels = ids.map(String);
        panelId =
          panels.find((id) => (wantedId ? id === wantedId : id.startsWith(prefix))) ?? null;
      }

      if (panelId) break;

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
        devtoolsPageLoaded,
        ...(!registryAnswered && registryError ? { registryUnreadable: registryError } : {}),
        reason: !registryAnswered
          ? `the DevTools panel registry could not be read (${registryError ?? "no answer"}), so whether a panel registered is unknown`
          : !devtoolsPageLoaded
            ? `the devtools page ${options.devtoolsPageUrl} never appeared as a frame within ${budgetMs}ms, so nothing could register a panel`
            : wantedId
              ? `no panel with id ${wantedId} registered within ${budgetMs}ms`
              : `no panel from ${prefix} registered within ${budgetMs}ms`,
      };
    }

    reached = "panel";
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

    reached = "show";
    let panelTarget: { targetId: string; url: string } | null = null;
    let panelTargetInferred = false;
    let panelFrameCandidates = 0;
    const showDeadline = Date.now() + 3000;

    for (;;) {
      const frames = (await listTargets().catch(() => [])).filter(
        (t) =>
          t.type === "iframe" &&
          String(t.url ?? "").startsWith(`${prefix}/`) &&
          !String(t.url ?? "").startsWith(options.devtoolsPageUrl),
      );
      panelFrameCandidates = frames.length;
      const fresh = frames.find((t) => !framesBefore.has(t.id));

      if (fresh) {
        panelTarget = { targetId: fresh.id, url: String(fresh.url) };
        break;
      }

      if (Date.now() >= showDeadline) {
        if (frames.length === 1) {
          panelTarget = { targetId: frames[0].id, url: String(frames[0].url) };
          panelTargetInferred = true;
        }

        break;
      }

      await sleep(200);
    }

    return {
      opened: true,
      devtoolsTargetId,
      panelId,
      panelTitle: panelTitleFromId(panelId, options.extensionId),
      panelTarget,
      ...(panelTargetInferred ? { panelTargetInferred } : {}),
      panelFrameCandidates,
      panels,
      reloadedInspected,
    };
  } catch (error) {
    /* @invariant THE STAGE IS THE ONE REACHED. */
    return {
      opened: false,
      stage: reached,
      reason: `${error instanceof Error ? error.message : String(error)} (after the ${reached} step)`,
    };
  } finally {
    try {
      cdp.disconnect();
    } catch {
    }
  }
}
