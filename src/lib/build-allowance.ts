// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { spendNarration, type SpendNarration } from "./allowance";
import { serverOf } from "./credential-server";
import { listCredentials } from "./credentials";
import { platformApiGet } from "./project-api";

export const LOW_BUILDS_REMAINING = 10;

export const LOW_BUILDS_SHARE = 0.05;

export interface BuildAllowance {
  used: number;
  limit: number;
  remaining: number;
  low: boolean;
}

export interface BuildAllowanceValue {
  used: number;
  limit: number;
  remaining: number;
  warning: string | null;
}

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function buildsRunLow(remaining: number, limit: number): boolean {
  return remaining < LOW_BUILDS_REMAINING || remaining < limit * LOW_BUILDS_SHARE;
}

export function readBuildAllowance(plan: unknown): BuildAllowance | null {
  const record = asRecord(plan);
  const used = asCount(asRecord(record?.used)?.buildsThisMonth);
  const limit = asCount(asRecord(record?.limits)?.buildsPerMonth);

  if (used === null || limit === null || limit === 0) return null;

  const remaining = Math.max(0, limit - used);

  return { used, limit, remaining, low: buildsRunLow(remaining, limit) };
}

/* @invariant THE PUSH COST IS SAID WITH ITS FILTERS. The platform builds a
 * push only on the project's build branch, only when it changes a file under
 * the root directory, and never when it changes only documentation or license
 * notices outside public/ (the webhook's BRANCH_FILTERED, PATH_FILTERED and
 * DOCS_ONLY outcomes); "each push spends one" read as a blanket rule and
 * became a project rule that had an agent ask the owner before every push
 * (ledger 426). */
export const PUSH_COST_SENTENCE =
  "each project creation spends one, and so does a push to the build branch that changes a file under the root directory; a push to another branch, one that changes only docs or license files outside public/, or one whose head commit says [skip build] (or [skip ci], or carries an Extension-Build: skip trailer) spends nothing (extension_builds list names each skipped push with its outcome).";

function buildsWord(count: number): string {
  return count === 1 ? "1 build remains" : `${count} builds remain`;
}

export function buildAllowanceWarning(allowance: BuildAllowance): string | null {
  if (!allowance.low) return null;

  return `${buildsWord(allowance.remaining)} of ${allowance.limit} this month; ${PUSH_COST_SENTENCE}`;
}

export function buildAllowanceValue(allowance: BuildAllowance): BuildAllowanceValue {
  return {
    used: allowance.used,
    limit: allowance.limit,
    remaining: allowance.remaining,
    warning: buildAllowanceWarning(allowance),
  };
}

export async function readWorkspaceBuildAllowance(args: {
  apiBase: string;
  workspace: string;
  command: string;
}): Promise<BuildAllowance | null> {
  const workspace = args.workspace.trim().toLowerCase();
  if (!workspace) return null;

  const base = args.apiBase.replace(/\/+$/, "");
  const server = serverOf(base);
  const now = Math.floor(Date.now() / 1000);
  const login = listCredentials()
    .filter((entry) => entry.server === server && entry.token)
    .filter((entry) => entry.workspaceSlug.toLowerCase() === workspace)
    .filter((entry) => !entry.expiresAt || entry.expiresAt > now)
    .sort((a, b) => Number(b.active) - Number(a.active) || b.expiresAt - a.expiresAt)[0];

  if (!login) return null;

  const read = await platformApiGet<Row>(
    { base, token: login.token, command: args.command },
    `/api/workspaces/${encodeURIComponent(workspace)}/plan`,
  );

  return read.ok ? readBuildAllowance(read.json) : null;
}

export interface FirstBuildSpend extends SpendNarration {
  remaining?: number;
  warning?: string;
}

export function firstBuildSpendNarration(options: {
  what: string;
  body?: unknown;
  api?: string;
  dispatched: boolean;
  before: BuildAllowance | null;
}): FirstBuildSpend {
  const narration = spendNarration({ what: options.what, body: options.body, api: options.api });
  const spends = options.dispatched ? 1 : 0;

  if (!options.before) {
    return {
      ...narration,
      remains: options.dispatched
        ? `${narration.remains} The first build spent one of the month's allowance; extension_workspace (action: info) reads what remains.`
        : narration.remains,
    };
  }

  const remaining = Math.max(0, options.before.remaining - spends);
  const after: BuildAllowance = {
    ...options.before,
    used: options.before.used + spends,
    remaining,
    low: buildsRunLow(remaining, options.before.limit),
  };
  const warning = buildAllowanceWarning(after);

  return {
    ...narration,
    remains: `Before this call the workspace had ${options.before.remaining} of ${options.before.limit} builds left this month${
      options.dispatched ? `; the first build spends one, leaving ${remaining}.` : ", and no first build spent one."
    }`,
    remaining,
    ...(warning ? { warning } : {}),
  };
}
