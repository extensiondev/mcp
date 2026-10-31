// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";

import type { RequirementRow } from "./store-requirements";

type Row = Record<string, unknown>;

export interface SummaryRowsArgs {
  summary: Row;
  platform: Row;
  recounted: boolean;
  rows: RequirementRow[] | null;
  checks: Row[];
  json: Row;
  store: string;
}

const ids = (value: unknown): string[] => (Array.isArray(value) ? value.map((id) => text(id)).filter(Boolean) : []);

const count = (value: unknown): number => (typeof value === "number" ? value : 0);

const blockingFail = (check: Row): boolean =>
  text(check.status) === "fail" && text(check.severity) !== "warning" && text(check.severity) !== "info";

function ruleBlockers(json: Row, store: string, counted: Set<string>): string[] {
  const block = json[`${store}Preflight`];
  if (!isRow(block)) return [];

  const blocking = ids(block.blocking);

  return store === "firefox" ? blocking : blocking.filter((id) => !counted.has(id));
}

export function requirementBlockersOf(platform: Row, rows: RequirementRow[] | null): string[] {
  const before = ids(platform.requirementBlockers);

  return rows ? before.filter((id) => rows.find((row) => row.id === id)?.status !== "have") : before;
}

export function summaryAgreeingWithRows(args: SummaryRowsArgs): Row {
  const before = ids(args.platform.requirementBlockers);
  const after = requirementBlockersOf(args.platform, args.rows);
  const removed = before.length - after.length;
  if (!args.recounted && removed === 0) return args.summary;

  const delta = args.recounted ? after.length : -removed;
  const review = isRow(args.summary.review) ? args.summary.review : null;
  const counted = new Set([...args.checks.filter(blockingFail).map((check) => text(check.id)), ...before]);
  const reviewChecksBlocking = args.checks.filter((check) => text(check.stage) === "review" && blockingFail(check)).length;
  const rules = ruleBlockers(args.json, args.store, counted);
  const own = reviewChecksBlocking === 0 && rules.length === 0;
  const added = args.recounted ? rules.length : 0;
  const integration = isRow(args.summary.integration) ? args.summary.integration : null;
  const kept = Object.fromEntries(Object.entries(args.summary).filter(([key]) => key !== "requirementBlockers"));

  return {
    ...kept,
    blockingFailures: Math.max(0, count(args.summary.blockingFailures) + delta + added),
    ...(added && integration
      ? {
          integration: {
            ...integration,
            blockingFailures: count(integration.blockingFailures) + added,
            canQueue: false,
          },
        }
      : {}),
    ...(review
      ? {
          review: {
            ...review,
            blockingFailures: Math.max(0, count(review.blockingFailures) + delta),
            canSubmitForReview: after.length === 0 && own,
          },
        }
      : {}),
    ...(added ? { canSubmit: false } : {}),
    ...(after.length ? { requirementBlockers: after } : {}),
  };
}
