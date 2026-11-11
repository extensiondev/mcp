// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { stampNow } from "../lib/act-outcome";
import { buildName, buildNumberOf } from "../lib/builds-list-row";
import { envelope } from "../lib/envelope";
import { projectApiGet, projectApiReadFailure, type ProjectApi, type ProjectApiRead } from "../lib/project-api";
import { WRITE_FAILURE_REPORT_URL } from "../lib/settings-write";
import { COMMAND, isRow, text, type Row } from "./builds-acts";

export const LOG_TAIL = 200;

const NO_STEP_RAN = "no_step_ran";
const EXIT_LINE = /^Process completed with exit code/i;

const NOT_RUN_REASON = "the run failed before this browser's job started";
const CANCELLED_REASON = "the run was canceled before this browser's job started";
const RUNNING_REASON = "the run is still in progress, and the platform reports a browser's lines once the build records them";
const FAILED_BUILD_STATUSES = new Set(["failed", "failure", "error", "timed_out", "cancelled", "canceled"]);

export interface LogsRead {
  api: ProjectApi;
  apiHint?: string;
  buildId: string;
  browser?: string;
  consoleUrl: string;
}

interface RunSection {
  status: string;
  conclusion: string | null;
  failedJob: Row | null;
  supersededBy?: string | null;
  validation?: Row | null;
}

export function cancelledSentence(buildId: string, supersededBy: unknown, buildNumber: number | null = null): string {
  const newer = text(supersededBy);
  const name = buildName(buildId, buildNumber);

  return newer
    ? `${name} was canceled because ${newer} landed; nothing is wrong with it.`
    : `${name} was canceled by the platform; nothing is wrong with it.`;
}

function runSectionOf(value: unknown): RunSection | null {
  if (!isRow(value)) return null;

  const failed = isRow(value.failedJob) ? value.failedJob : null;
  const lines = failed && Array.isArray(failed.lines) ? failed.lines.map((line) => text(line)).filter(Boolean) : [];

  const cancelled = text(value.conclusion).toLowerCase() === "cancelled";

  return {
    status: text(value.status) || "unknown",
    conclusion: text(value.conclusion) || null,
    ...(cancelled ? { supersededBy: text(value.supersededBy).slice(0, 7) || null } : {}),
    ...(isRow(value.validation) ? { validation: value.validation } : {}),
    failedJob: failed
      ? {
          name: text(failed.name),
          step: text(failed.step) || null,
          conclusion: text(failed.conclusion) || "failure",
          lines,
        }
      : null,
  };
}

function concluded(run: RunSection | null): boolean {
  return Boolean(run && (run.status === "completed" || run.conclusion));
}

function tailOf(item: Row): Row {
  const logs = Array.isArray(item.logs) ? item.logs : [];
  const omitted = Math.max(0, logs.length - LOG_TAIL);

  return {
    ...item,
    logs: omitted ? logs.slice(-LOG_TAIL) : logs,
    ...(omitted ? { omittedLines: omitted } : {}),
  };
}

function waitingForLines(item: Row): boolean {
  return text(item.status) === "pending" && !(Array.isArray(item.logs) && item.logs.length);
}

function settled(item: Row, run: RunSection | null, legacyFailed: boolean): Row {
  if (text(item.status) !== "pending") return item;
  if (!concluded(run) && !legacyFailed) return run && waitingForLines(item) ? { ...item, reason: text(item.reason) || RUNNING_REASON } : item;
  if (run?.conclusion === "cancelled") return { ...item, status: "cancelled", reason: text(item.reason) || CANCELLED_REASON };

  return { ...item, status: "skipped", reason: text(item.reason) || NOT_RUN_REASON };
}

export function hasFailureSummary(item: Row): boolean {
  if (typeof item.summarized === "boolean") return item.summarized;

  const logs = Array.isArray(item.logs) ? item.logs : [];

  return logs.some((line) => isRow(line) && ["error", "warning", "warn"].includes(text(line.level).toLowerCase()));
}

function validationSentence(validation: Row | null | undefined): string {
  if (!validation || validation.ran !== true) return "";

  const errors = Number(validation.errors) || 0;
  const warnings = Number(validation.warnings) || 0;
  const strict = validation.strict === true ? "on" : validation.strict === false ? "off" : "unknown";

  return ` The manifest validator reported ${errors} error${errors === 1 ? "" : "s"} and ${warnings} warning${warnings === 1 ? "" : "s"} (strict ${strict}); run.validation.diagnostics lists them per browser.`;
}

export function failedBrowsersHint(failedItems: Row[], validation: Row | null | undefined, buildPage: string): string {
  const summarized = failedItems.filter(hasFailureSummary);
  const unsummarized = failedItems.filter((item) => !hasFailureSummary(item));
  const parts: string[] = [];

  if (summarized.length) {
    const own = summarized.length === 1 ? "its" : "their";
    parts.push(`${summarized.map((item) => text(item.browser)).join(", ")} failed; ${own} lines lead with the platform's summary of the failure.`);
  }

  if (unsummarized.length) {
    const subject = unsummarized.map((item) => text(item.browser)).join(", ");
    const reason = text(unsummarized[0].reason);
    const where = buildPage ? ` The build page is ${buildPage}.` : "";

    parts.push(
      reason
        ? `${subject} failed with no failure line in ${unsummarized.length === 1 ? "its" : "their"} logs. ${reason}${where}`
        : `${subject} failed, but the platform sent no failure summary for ${unsummarized.length === 1 ? "it" : "them"}; the build page${buildPage ? ` at ${buildPage}` : ""} will show the cause once the platform relays it.`,
    );
  } else if (buildPage) {
    parts.push(`The build page is ${buildPage}.`);
  }

  return parts.join(" ") + validationSentence(validation);
}

function failedJobSentence(failedJob: Row, beforeBrowsers: boolean): string {
  const job = text(failedJob.name) || "a shared job";
  const step = text(failedJob.step);
  const where = step ? `${job} at step ${step}` : job;

  return beforeBrowsers ? `The run failed in ${where} before any browser built:` : `The run failed in ${where}:`;
}

export function platformFault(detail: unknown, buildId: string, lines: string[], lineSource: string): { value: Row; sentence: string } | null {
  const cause = isRow(detail) && isRow(detail.failureCause) ? detail.failureCause : null;
  if (!cause || text(cause.kind) !== NO_STEP_RAN) return null;

  const job = text(cause.jobName);
  const line = [...lines].reverse().find((said) => said && !EXIT_LINE.test(said)) ?? "";
  const where = job ? `the platform's ${job} job` : "a platform step";
  const paste = line ? `the platform's line: ${line}` : `the platform's line from ${lineSource}`;

  return {
    value: { owner: "platform", kind: NO_STEP_RAN, ...(job ? { jobName: job } : {}), buildId, reportUrl: WRITE_FAILURE_REPORT_URL, ...(line ? { line } : {}) },
    sentence: `This is a platform fault, nothing in the project caused it: ${where} failed before any project command ran, so do not rebuild. Report it at ${WRITE_FAILURE_REPORT_URL} with build ${buildId} and ${paste}.`,
  };
}

function legacyBuildFailed(detail: ProjectApiRead<Row>): { failed: boolean; cause: Row | null } {
  if (!detail.ok || !isRow(detail.json)) return { failed: false, cause: null };

  const status = text(detail.json.status).toLowerCase();
  const cause = isRow(detail.json.failureCause) ? detail.json.failureCause : null;

  return { failed: FAILED_BUILD_STATUSES.has(status), cause };
}

export async function readLogs(read: LogsRead): Promise<string> {
  const { buildId } = read;
  const route = `builds/${encodeURIComponent(buildId)}`;
  const [answer, detail] = await Promise.all([projectApiGet<Row>(read.api, `${route}/logs`), projectApiGet<Row>(read.api, route)]);

  if (!answer.ok) {
    return projectApiReadFailure(COMMAND, answer, {
      api: read.apiHint,
      name: "Builds",
      value: { action: "logs", buildId },
      notFound: "build",
    });
  }

  const wanted = text(read.browser).toLowerCase();
  const raw = (Array.isArray(answer.json.items) ? answer.json.items : []).filter(isRow);
  const run = runSectionOf(answer.json.run);
  const hasRunField = "run" in answer.json;
  const allPending = raw.length > 0 && raw.every((item) => text(item.status) === "pending");
  const legacy = !hasRunField && allPending ? legacyBuildFailed(detail) : { failed: false, cause: null };
  const all = raw.map((item) => settled(item, run, legacy.failed));
  const items = all.filter((item) => !wanted || text(item.browser).toLowerCase() === wanted).map(tailOf);
  const failed = items.filter((item) => text(item.status) === "failed").map((item) => text(item.browser));
  const skipped = items.filter((item) => text(item.status) === "skipped").map((item) => text(item.browser));
  const beforeBrowsers = all.length === 0 || all.every((item) => text(item.status) === "skipped");
  const canonical = text(answer.json.buildId) || buildId;
  const number = buildNumberOf(detail.ok ? detail.json : null);
  const cancelled = run?.conclusion === "cancelled" ? cancelledSentence(canonical, run.supersededBy, number) : "";
  const readAt = stampNow();
  const waiting = run && !concluded(run) && !legacy.failed ? items.filter(waitingForLines).map((item) => text(item.browser)) : [];
  const failedLines = run?.failedJob && Array.isArray(run.failedJob.lines) ? (run.failedJob.lines as string[]) : [];
  const fault = platformFault(detail.ok ? detail.json : null, canonical, failedLines, `the build page ${read.consoleUrl}`);

  let hint: string;

  if (cancelled) {
    hint = `${cancelled} The build page is ${read.consoleUrl}.`;
  } else if (fault) {
    hint = [fault.sentence, ...(failedLines.length ? ["The platform's lines:", ...failedLines] : []), `The build page is ${read.consoleUrl}.`].join("\n");
  } else if (run?.failedJob) {
    const lines = (run.failedJob.lines as string[]) ?? [];
    hint = [failedJobSentence(run.failedJob, beforeBrowsers), ...lines].join("\n");
    hint += `\n${skipped.length ? `${skipped.join(", ")} did not run. ` : ""}The build page is ${read.consoleUrl}.`;
  } else if (legacy.failed) {
    const job = text(legacy.cause?.jobName);
    const step = text(legacy.cause?.stepName);
    const where = step ? ` in ${job || "the build job"} at step ${step}` : "";
    hint = `The run failed${where} before the browser steps, so no browser built and none has lines. The build page is ${read.consoleUrl}.`;
  } else if (items.length === 0) {
    hint = wanted
      ? `No ${wanted} logs for ${buildName(canonical, number, "build")}; the build may not target ${wanted}. Browsers with logs: ${all.map((i) => text(i.browser)).join(", ") || "none"}.`
      : `No log lines are recorded for ${buildName(canonical, number, "build")} yet; the build page is ${read.consoleUrl}.`;
  } else if (failed.length) {
    hint = failedBrowsersHint(
      items.filter((item) => text(item.status) === "failed"),
      run?.validation,
      read.consoleUrl,
    );
  } else if (waiting.length) {
    hint = `The run is ${run?.status || "in progress"} as of ${readAt}, so ${waiting.join(", ")} ${waiting.length === 1 ? "has" : "have"} no lines yet: the platform reports a browser's lines once the build records them. extension_builds action:"get" with this buildId shows each browser's progress now; the build page is ${read.consoleUrl}.`;
  } else if (skipped.length === items.length) {
    hint = `The run ended before ${skipped.join(", ")} ran, so there are no lines. The build page is ${read.consoleUrl}.`;
  } else {
    hint = `Log lines for ${items.map((i) => text(i.browser)).join(", ")}. The build page is ${read.consoleUrl}.`;
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: {
      action: "logs",
      readAt,
      buildId: canonical,
      ...(number ? { buildNumber: number } : {}),
      ...(run ? { run } : {}),
      ...(fault ? { fault: fault.value } : {}),
      items,
      trackUrl: read.consoleUrl,
      ...(cancelled ? { sayToPerson: cancelled } : {}),
    },
    hint,
    warnings: [
      items.some((item) => item.omittedLines)
        ? `Long logs keep their last ${LOG_TAIL} lines; omittedLines says how many earlier lines were left out, and the build page has them all.`
        : null,
      legacy.failed ? `This platform does not report the run's failed step; the build page names it: ${read.consoleUrl}.` : null,
    ],
  });
}

export function buildFailures(detail: Row): { value: Row; sentence: string } | null {
  const validation = isRow(detail.validation) ? detail.validation : null;
  const checks = Array.isArray(validation?.checks) ? validation.checks.filter(isRow) : [];
  const manifest = checks.find((check) => text(check.id) === "manifest" && text(check.status).toLowerCase() === "failed");
  const outcome = isRow(detail.validationOutcome) ? detail.validationOutcome : null;
  const failedBrowsers = manifest && Array.isArray(manifest.browsers) ? manifest.browsers.map(text).filter(Boolean) : [];
  const validatorFailed = outcome && Array.isArray(outcome.failedBrowsers) ? outcome.failedBrowsers.map(text).filter(Boolean) : [];

  if (!manifest && !outcome) return null;

  const value: Row = {
    ...(failedBrowsers.length ? { failedBrowsers } : {}),
    ...(manifest ? { manifestCheck: text(manifest.detail) || null } : {}),
    ...(outcome ? { validation: outcome } : {}),
  };
  const parts: string[] = [];

  if (failedBrowsers.length) parts.push(`${failedBrowsers.join(", ")} failed (${text(manifest?.detail) || "manifest check failed"}).`);
  if (validatorFailed.length) parts.push(`The manifest validator failed ${validatorFailed.join(", ")} (failures.validation.diagnostics).`);
  else if (outcome && outcome.ran === true) parts.push(`The manifest validator failed no browser (${Number(outcome.errors) || 0} errors, ${Number(outcome.warnings) || 0} warnings).`);

  return { value, sentence: parts.join(" ") };
}
