// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  CALL_TIMEOUT,
  SESSION_BROWSER,
  SESSION_PROJECT_PATH,
} from "../lib/common-schema";
import { actFrameJson, runActVerb, commonFlags, type ActArgs } from "../lib/act";
import { readExecutorStamp, watchExecutorReattach } from "../lib/executor-stamp";
import { resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_reload",
  description:
    "Reload a running extension's background context, or a tab. Start the session with allowControl:true (extension_dev). A background reload answers once the engine's ready.json shows the new background attached to the dev server again (value.reattached, value.reattachedMs), so the next read or assertion meets the new generation and not the gap between them; if it has not come back within the budget (timeout, at most 5 seconds) the answer is status reloading with the contract's own stamps.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      context: {
        type: "string",
        enum: ["background", "content", "page"],
        default: "background",
      },
      tab: { type: "number", description: "For content/page: a specific tab id" },
      browser: SESSION_BROWSER,
      timeout: CALL_TIMEOUT,
    },
    required: ["projectPath"],
  },
};

const REATTACH_BUDGET_CEILING_MS = 5_000;

export async function handler(args: ActArgs): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  const before = readExecutorStamp(args.projectPath, browser);
  const raw = await runActVerb(
    ["reload", args.projectPath, ...commonFlags({ ...args, browser })],
    args.projectPath,
    args.timeout,
    schema.name,
  );

  if ((args.context ?? "background") !== "background") return raw;

  let frame: any;

  try {
    frame = JSON.parse(raw);
  } catch {
    return raw;
  }

  if (!frame || frame.ok !== true || frame.value?.reloading !== true) return raw;

  const budgetMs = Math.min(args.timeout ?? REATTACH_BUDGET_CEILING_MS, REATTACH_BUDGET_CEILING_MS);
  const watch = await watchExecutorReattach(args.projectPath, browser, before, budgetMs);
  const warnings: string[] = Array.isArray(frame.warnings) ? frame.warnings : [];
  const value = { ...frame.value, reattached: watch.outcome === "reattached", reattachWatch: watch.outcome, reattachedMs: watch.waitedMs };

  if (watch.outcome === "reattached") {
    frame.value = { ...value, ...(watch.detachedAt ? { detachedAt: watch.detachedAt } : {}), attachedTs: watch.attachedTs };
    frame.hint = `ready.json stamped the executor ${watch.detachedAt ? `detached at ${watch.detachedAt} and ` : ""}attached again ${watch.waitedMs} ms after the engine answered reloading, so the new background is connected to the dev server and the next read meets it.`;
  } else if (watch.outcome === "still-detached") {
    frame.status = "reloading";
    frame.value = { ...value, detachedAt: watch.detachedAt };
    warnings.push(
      `The engine answered reloading and ready.json stamped the executor detached at ${watch.detachedAt}, but it had not attached again ${watch.waitedMs} ms later: the new background has not connected to the dev server. Until ready.json reads runtime "attached", extension_assert answers inconclusive and reads refuse; extension_logs (context: ["background"]) shows what the new background wrote meanwhile.`,
    );
  } else if (watch.outcome === "unobserved") {
    frame.value = { ...value, reattached: null };
    warnings.push(
      `The engine answered reloading, but ready.json did not change in the ${watch.waitedMs} ms this server watched it (runtime still "${before?.runtime ?? "unstated"}", ts unchanged): no detach or reattach was stamped, so whether the background restarted is unknown. The old background may still be running.`,
    );
  } else {
    frame.value = { ...value, reattached: null };
    warnings.push(
      `The engine answered reloading, but this server could not read ready.json for ${browser} before the call, so the reattach was not watched; the next read may meet the gap between the old background and the new one.`,
    );
  }

  frame.warnings = warnings;

  return actFrameJson(frame);
}
