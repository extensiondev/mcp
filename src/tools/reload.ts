// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import {
  CALL_TIMEOUT,
  SESSION_BROWSER,
  SESSION_PROJECT_PATH,
} from "../lib/common-schema";
import { actFrameJson, runActVerb, commonFlags, type ActArgs } from "../lib/act";
import { readExecutorStamp, watchExecutorReattach } from "../lib/executor-stamp";
import { readyContractPath } from "../lib/session-paths";
import { COPY_IS_FIXED_LINE } from "../lib/start-answer";
import {
  ambiguousSessionRefusal,
  resolveSessionBrowser,
} from "../lib/session-browser";

export const schema = {
  name: "extension_reload",
  description:
    "Reload the extension's background, or a tab, over the control channel (allowControl); a background reload waits up to 5 s.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      context: {
        type: "string",
        enum: ["background", "content", "page"],
        default: "background",
        description: "Background, or a content or page tab.",
      },
      tab: { type: "number", description: "content/page: the tab id." },
      browser: SESSION_BROWSER,
      timeout: CALL_TIMEOUT,
    },
    required: ["projectPath"],
  },
};

const REATTACH_BUDGET_CEILING_MS = 5_000;

function productionCopy(projectPath: string, browser: string): string | null {
  try {
    const contract = JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as { command?: unknown; distPath?: unknown };
    if (contract.command !== "start" && contract.command !== "preview") return null;

    return typeof contract.distPath === "string" && contract.distPath ? contract.distPath : `dist/extension-js/${browser}/controlled`;
  } catch {
    return null;
  }
}

export async function handler(args: ActArgs): Promise<string> {
  const ambiguous = ambiguousSessionRefusal(schema.name, args.projectPath, args.browser);
  if (ambiguous) return ambiguous;

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

  const copy = productionCopy(args.projectPath, browser);

  if (copy) {
    frame.value = { ...frame.value, reloadedCopy: copy, copyRefreshed: false };
    warnings.push(`This is an extension_start session, so the reload ran the copy at ${copy}. ${COPY_IS_FIXED_LINE} For UI iteration with a person watching, extension_dev rebuilds and reloads in place without closing the window.`);
  }

  frame.warnings = warnings;

  return actFrameJson(frame);
}
