// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { openProjectApi, projectApiGet } from "./project-api";

type Row = Record<string, unknown>;

export type IntegrityVerdict = "passed" | "failed" | "not-reported" | "unread";

export interface FailedCheck {
  id: string;
  title?: string;
  detail?: string;
}

export interface BrowserHealth {
  browser: string;
  status: string | null;
  integrity: IntegrityVerdict;
  failedChecks: FailedCheck[];
  usable: boolean | null;
}

export type BuildHealth =
  | {
      checked: true;
      buildId: string;
      browsers: BrowserHealth[];
      good: string[];
      failed: string[];
      unchecked: string[];
    }
  | { checked: false; buildId: string; reason: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function failedChecksOf(body: Row): FailedCheck[] {
  const checks = Array.isArray(body.checks) ? body.checks.filter(isRow) : [];

  return checks
    .filter((check) => check.ok === false)
    .map((check) => {
      const row: FailedCheck = { id: text(check.id) };
      const title = text(check.title);
      const detail = text(check.detail);
      if (title) row.title = title;
      if (detail) row.detail = detail;

      return row;
    });
}

export function browserHealthOf(
  browser: string,
  status: string | null,
  read: { ok: true; json: unknown } | { ok: false; status: number; body: unknown },
): BrowserHealth {
  let integrity: IntegrityVerdict;
  let failedChecks: FailedCheck[] = [];

  if (read.ok && isRow(read.json)) {
    integrity = read.json.ok === true ? "passed" : "failed";
    if (integrity === "failed") failedChecks = failedChecksOf(read.json);
  } else if (!read.ok && read.status === 200 && read.body === null) {
    integrity = "not-reported";
  } else {
    integrity = "unread";
  }

  const statusFailed = (status ?? "").toLowerCase() === "failed";
  const usable = statusFailed || integrity === "failed" ? false : integrity === "passed" ? true : null;

  return { browser, status, integrity, failedChecks, usable };
}

export function summarizeBuildHealth(buildId: string, browsers: BrowserHealth[]): BuildHealth {
  return {
    checked: true,
    buildId,
    browsers,
    good: browsers.filter((b) => b.usable === true).map((b) => b.browser),
    failed: browsers.filter((b) => b.usable === false).map((b) => b.browser),
    unchecked: browsers.filter((b) => b.usable === null).map((b) => b.browser),
  };
}

export function everyArtifactFailed(health: BuildHealth): boolean {
  return health.checked && health.failed.length > 0 && health.good.length === 0 && health.unchecked.length === 0;
}

export function integrityWasChecked(health: BuildHealth): boolean {
  return health.checked && health.browsers.some((b) => b.integrity === "passed" || b.integrity === "failed");
}

export function describeBrowserHealth(b: BrowserHealth): string {
  const integrity =
    b.integrity === "passed"
      ? "integrity passed"
      : b.integrity === "failed"
        ? `integrity failed${
            b.failedChecks.length
              ? ` (${b.failedChecks.map((c) => [c.title || c.id, c.detail].filter(Boolean).join(": ")).join("; ")})`
              : ""
          }`
        : b.integrity === "not-reported"
          ? "no integrity report"
          : "integrity unreadable";

  return `${b.browser}: ${b.status ? `build ${b.status}, ` : ""}${integrity}`;
}

export async function readBuildHealth(args: {
  command: string;
  buildId: string;
  project?: string;
  api?: string;
}): Promise<BuildHealth> {
  const buildId = text(args.buildId);
  const opened = await openProjectApi({ command: args.command, project: args.project, api: args.api });

  if (!opened.ok) return { checked: false, buildId, reason: opened.message };

  const route = `builds/${encodeURIComponent(buildId)}`;
  const detail = await projectApiGet<Row>(opened.api, route);

  if (!detail.ok) return { checked: false, buildId, reason: detail.message };

  const rows = (Array.isArray(detail.json.browsers) ? detail.json.browsers : [])
    .map((b) =>
      isRow(b)
        ? { browser: text(b.name) || text(b.browser), status: text(b.status) || null }
        : { browser: text(b), status: null },
    )
    .filter((row) => row.browser);

  if (rows.length === 0) {
    return { checked: false, buildId, reason: `the platform's record of build ${buildId} lists no browsers` };
  }

  const reads = await Promise.all(
    rows.map((row) => projectApiGet(opened.api, `${route}/integrity/${encodeURIComponent(row.browser)}`)),
  );

  return summarizeBuildHealth(
    text(detail.json.buildId) || buildId,
    rows.map((row, i) => browserHealthOf(row.browser, row.status, reads[i])),
  );
}
