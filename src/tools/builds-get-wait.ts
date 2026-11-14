// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { OUTCOME_POLL_MS, outcomeClock, stampNow } from "../lib/act-outcome";
import { buildDispatchOf, forgetBuildDispatch, sameSha, unrecordedBackoffSeconds, unrecordedGetCall, type BuildDispatch } from "../lib/build-dispatches";
import { buildState, incompleteListWords, isActiveState, isRow, lastPushView, readsThatMayHideRows, text, unavailableReads, type Row } from "../lib/builds-list-row";
import { envelope } from "../lib/envelope";
import { projectApiGet, type ProjectApi, type ProjectApiRead, type ProjectApiRefusal } from "../lib/project-api";

export interface PushNaming {
  lastPush: Row | null;
  listed: Row | null;
  dispatch: BuildDispatch | null;
}

export interface WaitedRead {
  detail: ProjectApiRead<Row>;
  naming: PushNaming | null;
  incomplete: string[];
  started: number;
}

interface ListNaming extends Omit<PushNaming, "dispatch"> {
  incomplete: string[];
}

async function pushNaming(api: ProjectApi, buildId: string): Promise<ListNaming | null> {
  const read = await projectApiGet<{ items?: unknown[]; lastPush?: unknown; unavailable?: unknown }>(api, "builds", { limit: 10 });
  if (!read.ok || !isRow(read.json)) return null;

  const lastPush = isRow(read.json.lastPush) && sameSha(text(read.json.lastPush.commit), buildId) ? lastPushView(read.json.lastPush, []).lastPush : null;
  const items = Array.isArray(read.json.items) ? read.json.items.filter(isRow) : [];
  const listed = items.find((item) => [item.buildId, item.commit, item.id].some((sha) => sameSha(text(sha), buildId))) ?? null;
  const incomplete = listed ? [] : readsThatMayHideRows(unavailableReads(read.json.unavailable));

  return lastPush || listed || incomplete.length ? { lastPush, listed, incomplete } : null;
}

export async function readBuildWaiting(api: ProjectApi, buildId: string, boundMs: number): Promise<WaitedRead> {
  const route = `builds/${encodeURIComponent(buildId)}`;
  const started = outcomeClock.now();
  const left = () => boundMs - (outcomeClock.now() - started);
  let detail = await projectApiGet<Row>(api, route);
  let named: ListNaming | null = null;
  let dispatch: BuildDispatch | null = null;
  let misses = 0;

  for (;;) {
    if (detail.ok && !isActiveState(buildState(detail.json.status, detail.json.conclusion))) break;
    if (!detail.ok && detail.status !== 404) break;

    if (!detail.ok) {
      dispatch = dispatch ?? buildDispatchOf(api, buildId);
      named = named ?? (await pushNaming(api, buildId));
    }

    if ((!detail.ok && !named?.lastPush && !named?.listed && !dispatch) || left() <= 0) break;

    const pollMs = !detail.ok && dispatch ? unrecordedBackoffSeconds(misses++) * 1000 : OUTCOME_POLL_MS;
    await outcomeClock.sleep(Math.min(pollMs, Math.max(0, left())));
    detail = await projectApiGet<Row>(api, route);
  }

  if (detail.ok) forgetBuildDispatch(api, buildId);

  const known = Boolean(named?.lastPush || named?.listed || dispatch);
  const naming = detail.ok || !known ? null : { lastPush: named?.lastPush ?? null, listed: named?.listed ?? null, dispatch };

  return { detail, naming, incomplete: detail.ok || known ? [] : (named?.incomplete ?? []), started };
}

export function notFoundOnIncompleteList(command: string, buildId: string, detail: ProjectApiRefusal, incomplete: string[]): string {
  return envelope({
    ok: false,
    command,
    status: "not-found",
    value: { action: "get", buildId, unavailable: incomplete },
    error: {
      code: "E_BUILD_NOT_FOUND",
      name: "BuildsNotFound",
      ...(detail.code ? { platformCode: detail.code } : {}),
      message: detail.message,
    },
    hint: `The platform holds no record of build ${buildId}, and the builds list that would name a build still on its way came back incomplete: ${incompleteListWords(incomplete)}. So whether this build exists is not known; call extension_builds action:"get" with this buildId again shortly before concluding it does not.`,
  });
}

export function notRecordedYet(command: string, buildId: string, read: WaitedRead, boundMs: number, buildsPageUrl: string): string {
  const push = read.naming?.lastPush ?? null;
  const listed = read.naming?.listed ?? null;
  const dispatch = read.naming?.dispatch ?? null;
  const seconds = Math.round((outcomeClock.now() - read.started) / 1000);
  const said = [
    dispatch ? `this server dispatched a rebuild for it at ${dispatch.dispatchedAt}` : null,
    push ? `lastPush names it (${text(push.outcome) || "outcome unknown"}${text(push.receivedAt) ? `, received ${text(push.receivedAt)}` : ""})` : null,
    listed ? `the builds list shows it as ${text(listed.status) || "status unknown"}` : null,
  ].filter(Boolean);

  return envelope({
    ok: true,
    command,
    status: "not-recorded-yet",
    value: {
      action: "get",
      buildId,
      readAt: stampNow(),
      ...(dispatch ? { dispatch: { dispatchedAt: dispatch.dispatchedAt } } : {}),
      ...(push ? { lastPush: push } : {}),
      ...(listed ? { listed: { buildId: text(listed.buildId) || buildId, status: text(listed.status) || null } } : {}),
      ...(boundMs > 0 ? { waited: { seconds, settled: false } } : {}),
      trackUrl: buildsPageUrl,
    },
    hint: `The platform has not recorded build ${buildId} yet, but ${said.join(" and ")}. ${
      boundMs > 0 ? `The ${seconds} s wait passed before the record appeared; call` : "Call"
    } ${unrecordedGetCall(buildId)} to wait for its verdict${dispatch ? "; do not rebuild it again" : ""}.`,
  });
}
