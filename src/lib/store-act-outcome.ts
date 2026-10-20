// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { FAILED_STATUSES, linksOf, text, trackLinks, type ActLink, type LinkRow, type Verdict } from "./act-outcome";

import type { PlatformSubmission } from "./platform-submissions";

type Row = Record<string, unknown>;

const LIVE_STATUSES = new Set(["pending", "submitted"]);

export function judgePublish(record: PlatformSubmission): Verdict {
  const state = record.storeReview?.state;
  if (state) return { kind: "recorded", status: "in-review", storeState: state };

  const status = text(record.status).toLowerCase();
  if (FAILED_STATUSES.has(status)) return { kind: "recorded", status, failed: true };

  return { kind: "waiting", status: status || null };
}

export function judgeCancel(record: PlatformSubmission): Verdict {
  const status = text(record.status).toLowerCase();
  if (status && !LIVE_STATUSES.has(status)) return { kind: "recorded", status };

  return { kind: "waiting", status: status || null };
}

export function judgeRollout(percentage: number): (rollout: Row) => Verdict {
  return (rollout) => {
    const current = typeof rollout.percentage === "number" ? rollout.percentage : null;
    if (current === percentage) return { kind: "recorded", status: "rollout-raised", storeState: `${current}%` };

    return { kind: "waiting", status: current === null ? null : `${current}%` };
  };
}

export function actLinks(command: string, args: Row, status: string, value: Row, extra: LinkRow[] = [], trackAs: ActLink["kind"] = "track"): ActLink[] {
  const tracked = trackLinks(command, args, status, value).map((row) => (row.kind === "track" ? { ...row, kind: trackAs } : row));

  return linksOf([...tracked, ...extra]);
}

export function trackOf(links: ActLink[]): string {
  return links.find((link) => link.kind !== "item" && link.kind !== "approval")?.url ?? "";
}
