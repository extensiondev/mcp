// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { awaitRecordedOutcome, recordedOutcome, unrecordedOutcome, type ActOutcome, type LinkRow } from "./act-outcome";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { readShareRecord, type ShareRecord } from "./platform-share-read";

import type { ProjectRef } from "./registry";

type Row = Record<string, unknown>;

export function shareLinks(data: Row, track: { trackUrl: string; trackLinks?: string[] } | null, made: boolean): LinkRow[] {
  const rows = Array.isArray(data.links) ? data.links.filter((row): row is Row => Boolean(row) && typeof row === "object") : [];
  const own: LinkRow[] = rows.map((row) => {
    const kind = row.kind === "channel" ? ("channel" as const) : row.audience === "public" ? ("build" as const) : ("share" as const);

    return {
      ...row,
      kind,
      url: typeof row.url === "string" ? row.url : "",
      audience: "anyone with the link" as const,
      expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
      made: kind === "share" && made,
    };
  });

  return [
    ...own,
    ...(track ? [{ kind: "track" as const, url: track.trackUrl }] : []),
    ...(track?.trackLinks?.[1] ? [{ kind: "build" as const, url: track.trackLinks[1] }] : []),
  ];
}

export async function shareOutcome(args: {
  data: Row;
  ref: ProjectRef | null;
  shareId: string;
  noBuild: boolean;
  waitSeconds: unknown;
  api?: string;
}): Promise<{ outcome: ActOutcome; expiresAt: string | null }> {
  const { data } = args;
  const sha = typeof data.buildSha === "string" ? data.buildSha : "";
  const apiCheck = safeApiBase(resolveApiBase(args.api), args.api);

  if (args.noBuild) {
    return { outcome: unrecordedOutcome("the platform named no build for this link, so there is no served build to read back"), expiresAt: null };
  }

  if (data.visibility === "public") {
    return {
      outcome: sha && data.registryUrl ? recordedOutcome("public") : unrecordedOutcome("the project's build index could not be read, so the public build was not confirmed"),
      expiresAt: null,
    };
  }

  if (!args.shareId) return { outcome: unrecordedOutcome("the platform minted no short link, so there is no share record to read back"), expiresAt: null };
  if (!args.ref || !apiCheck.ok) return { outcome: unrecordedOutcome("the token's project is unknown, so the share record could not be read"), expiresAt: null };

  const ref = args.ref;
  const base = apiCheck.base;
  const waited = await awaitRecordedOutcome<ShareRecord>({
    waitSeconds: args.waitSeconds,
    read: () => readShareRecord({ base, id: args.shareId, ref, buildSha: sha }),
    judge: () => ({ kind: "recorded", status: "live" }),
  });

  return { outcome: waited.outcome, expiresAt: waited.record?.expiresAt ?? null };
}
