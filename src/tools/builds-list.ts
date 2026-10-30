// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import {
  browsersPendingSentence,
  headLagView,
  isRow,
  lastPushView,
  listRow,
  oneStampWarning,
  text,
} from "../lib/builds-list-row";
import { consoleProjectUrl } from "../lib/registry";
import { envelope } from "../lib/envelope";
import { openProjectApi, projectApiGet, projectApiOpenFailure, projectApiReadFailure } from "../lib/project-api";
import { cancelledSentence } from "./builds-logs";

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

export interface ListArgs {
  project?: string;
  api?: string;
  limit?: number;
}

export async function listBuilds(command: string, args: ListArgs): Promise<string> {
  const opened = await openProjectApi({ command, project: args.project, api: args.api });
  if (!opened.ok) return projectApiOpenFailure(command, opened, { api: args.api, name: "Builds", value: { action: "list" } });

  const limit = Math.min(Math.max(Math.floor(Number(args.limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
  const read = await projectApiGet<{
    items?: unknown[];
    dispatchDisabled?: boolean;
    pushRefusal?: unknown;
    lastPush?: unknown;
    headLag?: unknown;
  }>(opened.api, "builds", { limit });

  if (!read.ok) return projectApiReadFailure(command, read, { api: args.api, name: "Builds", value: { action: "list" } });

  const items = (Array.isArray(read.json?.items) ? read.json.items : []).filter(isRow);
  const rows = items.map((item) => listRow(item, (buildId) => consoleProjectUrl(opened.api.ref, ConsoleProjectPage.build(buildId), args.api)));
  const project = `${opened.api.ref.workspace}/${opened.api.ref.project}`;
  const buildsPageUrl = consoleProjectUrl(opened.api.ref, ConsoleProjectPage.builds, args.api);
  const cancelledSentences = rows.filter((row) => row.status === "cancelled").map((row) => cancelledSentence(text(row.buildId), row.supersededBy));
  const push = lastPushView(isRow(read.json?.lastPush) ? read.json.lastPush : null, rows);
  const headLag = headLagView(isRow(read.json?.headLag) && text(read.json.headLag.message) ? read.json.headLag : null);
  const spoken = [...(headLag ? [text(headLag.message)] : []), ...cancelledSentences];
  const noted = [push.sentence, browsersPendingSentence(rows)].filter((s): s is string => Boolean(s));
  const latest = rows[0];

  return envelope({
    ok: true,
    command,
    status: "listed",
    value: {
      action: "list",
      project,
      builds: rows,
      count: rows.length,
      limit,
      ...(read.json?.dispatchDisabled === true ? { dispatchDisabled: true } : {}),
      ...(read.json?.pushRefusal ? { pushRefusal: read.json.pushRefusal } : {}),
      ...(push.lastPush ? { lastPush: push.lastPush } : {}),
      ...(headLag ? { headLag } : {}),
      buildsPageUrl,
      trackUrl: buildsPageUrl,
      ...(spoken.length ? { sayToPerson: spoken.join(" ") } : {}),
    },
    hint: `${headLag ? `${text(headLag.message)} ` : ""}${
      latest
        ? `${rows.length} recent build${rows.length === 1 ? "" : "s"} of ${project}, newest first; the latest is ${latest.buildId} (${latest.status ?? "status unknown"}). Pass action:"get" or action:"logs" with a buildId to read one.${
            rows.some((row) => row.status === "partial") ? " A partial build finished with at least one browser failed; failedBrowsers names them." : ""
          }${cancelledSentences.length ? ` ${cancelledSentences.join(" ")}` : ""}${noted.length ? ` ${noted.join(" ")}` : ""}`
        : `No builds are recorded for ${project} yet.${noted.length ? ` ${noted.join(" ")}` : ""} Push a commit to produce one, then check ${buildsPageUrl}.`
    }`,
    warnings: [
      rows.length === limit ? `This is the newest ${limit}; raise limit (max ${MAX_LIMIT}) to see older builds.` : null,
      read.json?.dispatchDisabled === true ? "The platform reports build dispatch disabled right now, so new pushes are not building." : null,
      oneStampWarning(rows),
    ],
  });
}
