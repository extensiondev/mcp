// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "../lib/envelope";
import { projectApiGet, projectApiReadFailure, type ProjectApi } from "../lib/project-api";
import { COMMAND, isRow, text, type Row } from "./builds-acts";

export const LOG_TAIL = 200;

const NOT_RUN_REASON = "the run failed before this browser's job started";
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
  validation?: Row | null;
}

function runSectionOf(value: unknown): RunSection | null {
  if (!isRow(value)) return null;

  const failed = isRow(value.failedJob) ? value.failedJob : null;
  const lines = failed && Array.isArray(failed.lines) ? failed.lines.map((line) => text(line)).filter(Boolean) : [];

  return {
    status: text(value.status) || "unknown",
    conclusion: text(value.conclusion) || null,
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

function settled(item: Row, run: RunSection | null, legacyFailed: boolean): Row {
  if (text(item.status) !== "pending") return item;
  if (!concluded(run) && !legacyFailed) return item;

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

export function failedBrowsersHint(failedItems: Row[], validation: Row | null | undefined, runUrl: string): string {
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
    const where = runUrl ? ` The CI run is at ${runUrl}.` : "";

    parts.push(
      reason
        ? `${subject} failed with no failure line in ${unsummarized.length === 1 ? "its" : "their"} logs. ${reason}${where}`
        : `${subject} failed, but the platform sent no failure summary for ${unsummarized.length === 1 ? "it" : "them"}; the cause is only in the CI run${runUrl ? ` at ${runUrl}` : ""}.`,
    );
  } else if (runUrl) {
    parts.push(`The full CI run is at ${runUrl}.`);
  }

  return parts.join(" ") + validationSentence(validation);
}

function failedJobSentence(failedJob: Row, beforeBrowsers: boolean): string {
  const job = text(failedJob.name) || "a shared job";
  const step = text(failedJob.step);
  const where = step ? `${job} at step ${step}` : job;

  return beforeBrowsers ? `The run failed in ${where} before any browser built:` : `The run failed in ${where}:`;
}

async function legacyBuildFailed(read: LogsRead): Promise<{ failed: boolean; cause: Row | null }> {
  const detail = await projectApiGet<Row>(read.api, `builds/${encodeURIComponent(read.buildId)}`);
  if (!detail.ok || !isRow(detail.json)) return { failed: false, cause: null };

  const status = text(detail.json.status).toLowerCase();
  const cause = isRow(detail.json.failureCause) ? detail.json.failureCause : null;

  return { failed: FAILED_BUILD_STATUSES.has(status), cause };
}

export async function readLogs(read: LogsRead): Promise<string> {
  const { buildId } = read;
  const answer = await projectApiGet<Row>(read.api, `builds/${encodeURIComponent(buildId)}/logs`);

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
  const legacy = !hasRunField && allPending ? await legacyBuildFailed(read) : { failed: false, cause: null };
  const all = raw.map((item) => settled(item, run, legacy.failed));
  const items = all.filter((item) => !wanted || text(item.browser).toLowerCase() === wanted).map(tailOf);
  const runUrl = text(answer.json.runUrl);
  const failed = items.filter((item) => text(item.status) === "failed").map((item) => text(item.browser));
  const skipped = items.filter((item) => text(item.status) === "skipped").map((item) => text(item.browser));
  const beforeBrowsers = all.length === 0 || all.every((item) => text(item.status) === "skipped");
  const runAt = runUrl ? ` The full CI run is at ${runUrl}.` : "";

  let hint: string;

  if (run?.failedJob) {
    const lines = (run.failedJob.lines as string[]) ?? [];
    hint = [failedJobSentence(run.failedJob, beforeBrowsers), ...lines].join("\n");
    hint += `\n${skipped.length ? `${skipped.join(", ")} did not run.` : ""}${runAt} The build page is ${read.consoleUrl}.`;
  } else if (legacy.failed) {
    const job = text(legacy.cause?.jobName);
    const step = text(legacy.cause?.stepName);
    const where = step ? ` in ${job || "the build job"} at step ${step}` : "";
    hint = `The run failed${where} before the browser steps, so no browser built and none has lines. The build page is ${read.consoleUrl}.${runAt}`;
  } else if (items.length === 0) {
    hint = wanted
      ? `No ${wanted} logs for build ${buildId}; the build may not target ${wanted}. Browsers with logs: ${all.map((i) => text(i.browser)).join(", ") || "none"}.`
      : `No log lines are recorded for build ${buildId} yet${runUrl ? `; the CI run is at ${runUrl}` : ""}.`;
  } else if (failed.length) {
    hint = failedBrowsersHint(
      items.filter((item) => text(item.status) === "failed"),
      run?.validation,
      runUrl,
    );
  } else if (skipped.length === items.length) {
    hint = `The run ended before ${skipped.join(", ")} ran, so there are no lines.${runAt} The build page is ${read.consoleUrl}.`;
  } else {
    hint = `Log lines for ${items.map((i) => text(i.browser)).join(", ")}.${runAt}`;
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: {
      action: "logs",
      buildId: text(answer.json.buildId) || buildId,
      ...(run ? { run } : {}),
      ...(runUrl ? { runUrl } : {}),
      items,
    },
    hint,
    warnings: [
      items.some((item) => item.omittedLines)
        ? `Long logs keep their last ${LOG_TAIL} lines; omittedLines says how many earlier lines were left out, and the CI run has them all.`
        : null,
      legacy.failed ? "This platform does not report the run's failed step; the build page and CI run name it." : null,
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
