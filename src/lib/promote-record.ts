// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import {
  FAILED_STATUSES,
  PENDING_STATUSES,
  after,
  awaitRecordedOutcome,
  isRow,
  linksOf,
  text,
  trackLinks,
  type ActLink,
  type AwaitedOutcome,
  type RecordRead,
  type Verdict,
} from "./act-outcome";
import { openProjectApi, projectApiGet } from "./project-api";
import { channelsShapeProblem, consoleProjectUrl, fetchRegistryJson, parseChannels, registryFileUrl, type ProjectRef } from "./registry";

type Row = Record<string, unknown>;

function sameBuild(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();

  return Boolean(x) && Boolean(y) && (x.startsWith(y) || y.startsWith(x));
}

export function judgeRelease(item: Row): Verdict {
  const status = text(item.status).toLowerCase();
  if (PENDING_STATUSES.has(status)) return { kind: "waiting", status };
  if (FAILED_STATUSES.has(status)) return { kind: "recorded", status, failed: true };

  return { kind: "recorded", status: status || "promoted" };
}

export async function awaitPromoteRecord(args: {
  command: string;
  project?: string;
  api?: string;
  channel: string;
  buildId: string;
  acceptedAt: string;
  waitSeconds: unknown;
}): Promise<AwaitedOutcome<Row>> {
  const sinceIso = new Date(Date.parse(args.acceptedAt) - 60_000).toISOString();
  const opened = await openProjectApi({ command: args.command, project: args.project, api: args.api });

  const read = async (): Promise<RecordRead<Row>> => {
    if (!opened.ok) return { ok: false, message: opened.message };

    const list = await projectApiGet<{ items?: unknown }>(opened.api, "releases");
    if (!list.ok) return { ok: false, message: list.message };

    const items = (Array.isArray(list.json.items) ? list.json.items : []).filter(isRow);
    const match = items.find((item) => {
      if (text(item.channel) !== args.channel || !sameBuild(text(item.buildId) || text(item.build), args.buildId)) return false;

      const at = text(item.createdAt) || text(item.promotedAt) || text(item.startedAt);

      return !at || after(at, sinceIso);
    });

    return { ok: true, record: match ?? null };
  };

  return awaitRecordedOutcome<Row>({ waitSeconds: args.waitSeconds, read, judge: judgeRelease });
}

export function promoteLinks(args: {
  command: string;
  callArgs: Row;
  value: Row;
  releaseId: string;
  channelUrl: unknown;
  publicBuildUrl: string | null | undefined;
}): ActLink[] {
  return linksOf([
    ...trackLinks(args.command, args.callArgs, "promoted", { ...args.value, ...(args.releaseId ? { releaseId: args.releaseId } : {}) }).map((row) =>
      row.kind === "track" ? { ...row, kind: "release" as const, made: Boolean(args.releaseId) } : row,
    ),
    ...(typeof args.channelUrl === "string" ? [{ kind: "channel" as const, url: args.channelUrl }] : []),
    ...(args.publicBuildUrl ? [{ kind: "build" as const, url: args.publicBuildUrl }] : []),
  ]);
}

export function releasesPage(ref: ProjectRef | null, api?: string): string {
  return consoleProjectUrl(ref, ConsoleProjectPage.releases, api);
}

export async function unknownBuildEnrichment(ref: ProjectRef | null, api?: string): Promise<Row> {
  const enrich: Row = { buildsPageUrl: consoleProjectUrl(ref, "builds", api) };
  if (!ref) return enrich;

  const channelsUrl = registryFileUrl(ref, "channels.json", api);
  const channelsRes = await fetchRegistryJson(channelsUrl, fetch, { ref, api });

  if (channelsRes.ok) {
    const rows = channelsShapeProblem(channelsRes.json) ? [] : parseChannels(channelsRes.json).filter((c) => c.sha);
    enrich.validChannelShas = Object.fromEntries(rows.map((c) => [c.channel, c.sha]));
    enrich.registryChannelsUrl = channelsUrl;
  }

  return enrich;
}
