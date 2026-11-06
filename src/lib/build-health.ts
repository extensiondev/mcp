// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { buildNumberOf } from "./builds-list-row";
import { isPackageArtifact, packageFileOf } from "./package-address";
import { openProjectApi, projectApiGet } from "./project-api";

type Row = Record<string, unknown>;

export type IntegrityVerdict = "passed" | "failed" | "stale" | "not-reported" | "unread";

export type Freshness = "current" | "stale" | "unknown";

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
  checkedAt: string | null;
  checkedRun: string | null;
  freshness: Freshness;
  staleVerdict?: "passed" | "failed";
  recorded?: false;
  servedOnly?: true;
}

export interface BuildRun {
  status: string | null;
  runId: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface IntegrityProvenance {
  checkedAt?: unknown;
  runId?: unknown;
  fromEarlierRun?: boolean;
}

export type BuildHealth =
  | {
      checked: true;
      buildId: string;
      buildNumber?: number;
      run?: BuildRun;
      browsers: BrowserHealth[];
      good: string[];
      failed: string[];
      unchecked: string[];
    }
  | { checked: false; buildId: string; reason: string; status?: number };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const PACKAGE_NAME = /^([a-z]+)-extension\.(?:zip|xpi|crx)$/i;

function packageBrowserOf(row: Row): string {
  const named = text(row.browser) || PACKAGE_NAME.exec(text(row.name))?.[1] || packageFileOf(row.downloadUrl)?.browser || "";
  const browser = named.toLowerCase();

  return browser === "source" ? "" : browser;
}

export function packageBrowsersOf(artifacts: unknown): string[] {
  const rows = Array.isArray(artifacts) ? artifacts.filter(isRow) : [];
  const found: string[] = [];

  for (const row of rows) {
    if (!isPackageArtifact(row)) continue;

    const browser = packageBrowserOf(row);
    if (browser && !found.includes(browser)) found.push(browser);
  }

  return found;
}

export function unrecordedBrowsers(recorded: string[], artifacts: unknown): string[] {
  const known = new Set(recorded.map((name) => name.toLowerCase()));

  return packageBrowsersOf(artifacts).filter((browser) => !known.has(browser));
}

export function servedOnlyReason(browser: string): string {
  return `the platform's record of this build has no ${browser} row and its artifact list no ${browser} package, so ${browser} was never checked, and the ${browser} run command in value.previewCommands hands over an unchecked file`;
}

/* @invariant EVERY BROWSER A PUBLISH SERVES APPEARS ONCE IN THE VERDICT. The
 * platform's publish answer builds its run commands from the build's browser
 * list, while the integrity verdict is built from the build record's rows
 * and its artifact list; a Safari build whose record and artifact list both
 * omit safari answered a safari.zip command beside a verdict that named
 * three browsers and nothing about the fourth (ledger 431). A served browser
 * the verdict never saw is listed as unchecked with its own reason, never
 * dropped and never called good. */
export function withServedBrowsers(health: BuildHealth, served: string[]): BuildHealth {
  if (!health.checked) return health;

  const known = new Set(health.browsers.map((b) => b.browser.toLowerCase()));
  const rows: BrowserHealth[] = served
    .map((browser) => browser.toLowerCase())
    .filter((browser, i, all) => browser && !known.has(browser) && all.indexOf(browser) === i)
    .map((browser) => ({ browser, status: null, integrity: "unread", failedChecks: [], usable: null, checkedAt: null, checkedRun: null, freshness: "unknown", recorded: false, servedOnly: true }));

  return rows.length ? summarizeBuildHealth(health.buildId, [...health.browsers, ...rows], health.run, health.buildNumber ?? null) : health;
}

export function unrecordedRowReason(browser: string): string {
  return `the platform's record of this build has no row for ${browser} yet, while its artifact list carries a ${browser} package`;
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

function runText(value: unknown): string {
  if (isRow(value)) return text(value.runId) || text(value.id);

  return text(value);
}

function timeOf(value: string | null): number | null {
  if (!value) return null;

  const ms = Date.parse(value);

  return Number.isFinite(ms) ? ms : null;
}

export function provenanceOf(
  explicit: IntegrityProvenance | undefined,
  report: unknown,
): { checkedAt: string | null; checkedRun: string | null; fromEarlierRun?: boolean } {
  const body = isRow(report) ? report : {};
  const checkedAt = text(explicit?.checkedAt) || text(body.checkedAt) || text(body.generatedAt);
  const checkedRun = runText(explicit?.runId) || runText(body.runId) || runText(body.run);

  return {
    checkedAt: checkedAt || null,
    checkedRun: checkedRun || null,
    ...(typeof explicit?.fromEarlierRun === "boolean" ? { fromEarlierRun: explicit.fromEarlierRun } : {}),
  };
}

export function freshnessOf(
  checked: { checkedAt: string | null; checkedRun: string | null; fromEarlierRun?: boolean },
  run: Pick<BuildRun, "runId" | "startedAt"> | undefined,
): Freshness {
  if (checked.fromEarlierRun === true) return "stale";
  if (checked.checkedRun && run?.runId) return checked.checkedRun === run.runId ? "current" : "stale";

  const at = timeOf(checked.checkedAt);
  const started = timeOf(run?.startedAt ?? null);
  if (at === null || started === null) return "unknown";

  return at < started ? "stale" : "current";
}

export function browserHealthOf(
  browser: string,
  status: string | null,
  read: { ok: true; json: unknown } | { ok: false; status: number; body: unknown },
  context: { explicit?: IntegrityProvenance; run?: BuildRun; recorded?: boolean } = {},
): BrowserHealth {
  let integrity: IntegrityVerdict;
  let failedChecks: FailedCheck[] = [];
  let staleVerdict: "passed" | "failed" | undefined;
  const report = read.ok && isRow(read.json) ? read.json : null;
  const checked = provenanceOf(context.explicit, report);
  const freshness = report ? freshnessOf(checked, context.run) : "unknown";

  if (report) {
    integrity = report.ok === true ? "passed" : "failed";
    if (integrity === "failed") failedChecks = failedChecksOf(report);

    if (freshness === "stale") {
      staleVerdict = integrity;
      integrity = "stale";
    }
  } else if (!read.ok && read.status === 200 && read.body === null) {
    integrity = "not-reported";
  } else {
    integrity = "unread";
  }

  const statusFailed = (status ?? "").toLowerCase() === "failed";
  const verdict = staleVerdict ?? integrity;
  const usable =
    statusFailed || verdict === "failed" ? false : integrity === "passed" ? true : null;

  return {
    browser,
    status,
    integrity,
    failedChecks,
    usable,
    checkedAt: checked.checkedAt,
    checkedRun: checked.checkedRun,
    freshness,
    ...(staleVerdict ? { staleVerdict } : {}),
    ...(context.recorded === false ? { recorded: false as const } : {}),
  };
}

export function summarizeBuildHealth(buildId: string, browsers: BrowserHealth[], run?: BuildRun, buildNumber: number | null = null): BuildHealth {
  return {
    checked: true,
    buildId,
    ...(buildNumber ? { buildNumber } : {}),
    ...(run ? { run } : {}),
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
  return health.checked && health.browsers.some((b) => b.integrity === "passed" || b.integrity === "failed" || b.integrity === "stale");
}

export function staleFailures(health: BuildHealth): boolean {
  if (!health.checked) return false;

  const failing = health.browsers.filter((b) => b.usable === false);

  return (
    failing.length > 0 &&
    failing.every((b) => b.integrity === "stale" && (b.status ?? "").toLowerCase() !== "failed")
  );
}

function failedChecksText(b: BrowserHealth): string {
  return b.failedChecks.length
    ? ` (${b.failedChecks.map((c) => [c.title || c.id, c.detail].filter(Boolean).join(": ")).join("; ")})`
    : "";
}

export function describeBrowserHealth(b: BrowserHealth): string {
  const integrity =
    b.integrity === "stale"
      ? `integrity ${b.staleVerdict ?? "checked"}${b.staleVerdict === "failed" ? failedChecksText(b) : ""} on an earlier run${
          b.checkedAt ? `, checked ${b.checkedAt}` : ""
        }`
      : b.integrity === "passed"
      ? "integrity passed"
      : b.integrity === "failed"
        ? `integrity failed${failedChecksText(b)}`
        : b.integrity === "not-reported"
          ? "no integrity report"
          : "integrity unreadable";

  return `${b.browser}: ${b.status ? `build ${b.status}, ` : b.recorded === false ? "no row in the build record, " : ""}${integrity}`;
}

function explicitProvenance(row: Row): IntegrityProvenance | undefined {
  const integrity = isRow(row.integrity) ? row.integrity : {};
  const checkedAt = text(integrity.checkedAt) || text(row.integrityCheckedAt);
  const runId = runText(integrity.runId) || runText(integrity.run) || runText(row.integrityRunId);
  const fromEarlierRun = typeof integrity.fromEarlierRun === "boolean" ? integrity.fromEarlierRun : undefined;

  return checkedAt || runId || fromEarlierRun !== undefined ? { checkedAt, runId, fromEarlierRun } : undefined;
}

export function runOf(detail: Row): BuildRun {
  return {
    status: text(detail.status) || null,
    runId: runText(detail.runId) || null,
    startedAt: text(detail.startedAt) || null,
    completedAt: text(detail.completedAt) || null,
  };
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

  if (!detail.ok) return { checked: false, buildId, reason: detail.message, status: detail.status };

  const recorded = (Array.isArray(detail.json.browsers) ? detail.json.browsers : [])
    .map((b) =>
      isRow(b)
        ? { browser: text(b.name) || text(b.browser), status: text(b.status) || null, explicit: explicitProvenance(b), recorded: true }
        : { browser: text(b), status: null, explicit: undefined, recorded: true },
    )
    .filter((row) => row.browser);
  const artifacts = await projectApiGet<unknown[]>(opened.api, `${route}/artifacts`);
  const rows = [
    ...recorded,
    ...unrecordedBrowsers(
      recorded.map((row) => row.browser),
      artifacts.ok ? artifacts.json : [],
    ).map((browser) => ({ browser, status: null, explicit: undefined, recorded: false })),
  ];

  if (rows.length === 0) {
    return { checked: false, buildId, reason: `the platform's record of build ${buildId} lists no browsers` };
  }

  const reads = await Promise.all(
    rows.map((row) => projectApiGet(opened.api, `${route}/integrity/${encodeURIComponent(row.browser)}`)),
  );

  const run = runOf(detail.json);

  return summarizeBuildHealth(
    text(detail.json.buildId) || buildId,
    rows.map((row, i) => browserHealthOf(row.browser, row.status, reads[i], { explicit: row.explicit, run, recorded: row.recorded })),
    run,
    buildNumberOf(detail.json),
  );
}
