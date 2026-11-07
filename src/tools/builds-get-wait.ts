// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { OUTCOME_POLL_MS, outcomeClock, stampNow } from "../lib/act-outcome";
import { buildState, isActiveState, isRow, lastPushView, text, type Row } from "../lib/builds-list-row";
import { envelope } from "../lib/envelope";
import { projectApiGet, type ProjectApi, type ProjectApiRead } from "../lib/project-api";

export interface PushNaming {
  lastPush: Row | null;
  listed: Row | null;
}

export interface WaitedRead {
  detail: ProjectApiRead<Row>;
  naming: PushNaming | null;
  started: number;
}

function sameSha(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (Math.min(x.length, y.length) < 7) return x === y && x.length > 0;

  return x.startsWith(y) || y.startsWith(x);
}

async function pushNaming(api: ProjectApi, buildId: string): Promise<PushNaming | null> {
  const read = await projectApiGet<{ items?: unknown[]; lastPush?: unknown }>(api, "builds", { limit: 10 });
  if (!read.ok || !isRow(read.json)) return null;

  const lastPush = isRow(read.json.lastPush) && sameSha(text(read.json.lastPush.commit), buildId) ? lastPushView(read.json.lastPush, []).lastPush : null;
  const items = Array.isArray(read.json.items) ? read.json.items.filter(isRow) : [];
  const listed = items.find((item) => [item.buildId, item.commit, item.id].some((sha) => sameSha(text(sha), buildId))) ?? null;

  return lastPush || listed ? { lastPush, listed } : null;
}

export async function readBuildWaiting(api: ProjectApi, buildId: string, boundMs: number): Promise<WaitedRead> {
  const route = `builds/${encodeURIComponent(buildId)}`;
  const started = outcomeClock.now();
  const left = () => boundMs - (outcomeClock.now() - started);
  let detail = await projectApiGet<Row>(api, route);
  let naming: PushNaming | null = null;

  for (;;) {
    if (detail.ok && !isActiveState(buildState(detail.json.status, detail.json.conclusion))) break;
    if (!detail.ok && detail.status !== 404) break;
    if (!detail.ok) naming = naming ?? (await pushNaming(api, buildId));
    if ((!detail.ok && !naming) || left() <= 0) break;

    await outcomeClock.sleep(Math.min(OUTCOME_POLL_MS, Math.max(0, left())));
    detail = await projectApiGet<Row>(api, route);
  }

  return { detail, naming: detail.ok ? null : naming, started };
}

export function notRecordedYet(command: string, buildId: string, read: WaitedRead, boundMs: number, buildsPageUrl: string): string {
  const push = read.naming?.lastPush ?? null;
  const listed = read.naming?.listed ?? null;
  const seconds = Math.round((outcomeClock.now() - read.started) / 1000);
  const said = [
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
      ...(push ? { lastPush: push } : {}),
      ...(listed ? { listed: { buildId: text(listed.buildId) || buildId, status: text(listed.status) || null } } : {}),
      ...(boundMs > 0 ? { waited: { seconds, settled: false } } : {}),
      trackUrl: buildsPageUrl,
    },
    hint: `The platform has not recorded build ${buildId} yet, but ${said.join(" and ")}. ${
      boundMs > 0 ? `The ${seconds}s wait passed before the record appeared; call` : "Call"
    } get again with waitSeconds to wait for its verdict.`,
  });
}
