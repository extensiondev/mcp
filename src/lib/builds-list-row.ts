// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export type Row = Record<string, unknown>;

export type BuildState = "success" | "failed" | "cancelled" | "building" | "pending";

const SUCCESS_WORDS = new Set(["success", "succeeded", "ready", "passing", "passed"]);
const FAILED_WORDS = new Set([
  "failed",
  "failure",
  "failing",
  "error",
  "timed_out",
  "timedout",
  "startup_failure",
  "action_required",
  "stale",
  "neutral",
  "skipped",
]);
const CANCELLED_WORDS = new Set(["cancelled", "canceled"]);
const BUILDING_WORDS = new Set(["building", "running", "in_progress", "in progress"]);
const PENDING_WORDS = new Set(["pending", "queued", "waiting", "requested"]);
const QUEUED_PUSH_OUTCOMES = new Set(["DEBOUNCED", "DEFERRED", "HEAD_QUEUED"]);
const SETTINGS_SKIP_OUTCOMES = new Set(["SKIP_REQUESTED", "BRANCH_FILTERED", "PATH_FILTERED", "DOCS_ONLY", "PULL_REQUEST_BUILDS_OFF"]);

export const BROWSERS_NOT_REPORTED = "the platform has not reported this run's browsers yet; they land with the build record";

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

export function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function word(value: unknown): string {
  return text(value).toLowerCase();
}

export function buildNumberOf(value: unknown): number | null {
  const raw = isRow(value) ? value.buildNumber : value;

  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;
}

export function buildName(buildId: string, number: number | null, bare = "Build"): string {
  return number ? `Build #${number} (${buildId})` : `${bare} ${buildId}`.trim();
}

export function rowWords(row: Row, status: string): string {
  const number = buildNumberOf(row);
  const buildId = text(row.buildId);

  return number ? `Build #${number} (${buildId}, ${status})` : `${buildId} (${status})`;
}

export function buildState(statusLike: unknown, conclusionLike?: unknown): BuildState | string {
  const status = word(statusLike);
  const conclusion = word(conclusionLike);

  if (status === "completed") {
    if (conclusion === "success") return "success";

    return CANCELLED_WORDS.has(conclusion) ? "cancelled" : "failed";
  }

  if (SUCCESS_WORDS.has(status)) return "success";
  if (CANCELLED_WORDS.has(status)) return "cancelled";
  if (FAILED_WORDS.has(status)) return "failed";
  if (BUILDING_WORDS.has(status)) return "building";
  if (PENDING_WORDS.has(status)) return "pending";
  if (!status && conclusion) return buildState(conclusion);

  return status;
}

export function isActiveState(state: unknown): boolean {
  return state === "building" || state === "pending";
}

export function isoSeconds(value: unknown): string {
  const raw = text(value);
  if (!raw) return "";

  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;

  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function browsersOf(item: Row): string[] {
  return Array.isArray(item.browsers)
    ? item.browsers.map((b) => (isRow(b) ? text(b.browser) || text(b.name) : text(b))).filter(Boolean)
    : [];
}

function withTimes(out: Row, item: Row, active: boolean): void {
  const startedAt = isoSeconds(active ? item.startedAt || item.timestamp : item.startedAt);
  const completedAt = active ? "" : isoSeconds(item.completedAt);
  const duration = text(item.duration);

  if (active) {
    if (startedAt) out.startedAt = startedAt;
    if (duration) out.runningFor = duration;

    return;
  }

  const lone = isoSeconds(item.timestamp);

  if (!startedAt && !completedAt && lone) {
    out.timestamp = lone;
  } else if (startedAt && completedAt && startedAt === completedAt) {
    out.timestamp = startedAt;
  } else {
    if (startedAt) out.startedAt = startedAt;
    if (completedAt) out.completedAt = completedAt;
  }

  if (duration) out.duration = duration;
}

export function listRow(item: Row, consoleUrl: (buildId: string) => string): Row {
  const buildId = text(item.buildId) || text(item.shortSha) || text(item.id);
  const state = buildState(item.status, item.conclusion);
  const active = isActiveState(state);
  const browsers = browsersOf(item);
  const out: Row = { buildId };
  const number = buildNumberOf(item);
  if (number) out.buildNumber = number;

  const fields: Array<[string, unknown]> = [
    ["sha", item.commit],
    ["status", state],
    ["env", item.buildEnv],
    ["channel", item.channel],
    ["version", item.version],
    ["branch", item.branch],
    ["message", item.message],
  ];

  for (const [key, value] of fields) {
    const v = text(value);
    if (v) out[key] = v;
  }

  withTimes(out, item, active);
  if (text(item.deploymentId)) out.deploymentId = text(item.deploymentId);

  const verdict = word(item.summaryStatus || item.conclusion);
  if (!active && verdict) out.conclusion = verdict === "partial" ? verdict : buildState(verdict);
  if (typeof item.runId === "number" && item.runId > 0) out.internal = { runId: item.runId };
  if (state === "cancelled") out.supersededBy = text(item.supersededBy).slice(0, 7) || null;

  if (!active && (word(out.conclusion) === "partial" || word(item.outcome) === "partial")) {
    if (state === "success") out.runStatus = "success";

    out.status = "partial";
    out.conclusion = "partial";
    const failedBrowsers = Array.isArray(item.failedBrowsers) ? item.failedBrowsers.map(text).filter(Boolean) : [];
    if (failedBrowsers.length) out.failedBrowsers = failedBrowsers;
  }

  out.browsers = browsers;
  if (active && browsers.length === 0) out.browsersNote = BROWSERS_NOT_REPORTED;
  if (buildId) out.consoleUrl = consoleUrl(buildId);

  return out;
}

export function oneStampWarning(rows: Row[]): string | null {
  const ids = rows.filter((row) => text(row.timestamp)).map((row) => buildName(text(row.buildId), buildNumberOf(row), ""));
  if (!ids.length) return null;

  return `The platform recorded one timestamp for build${ids.length === 1 ? "" : "s"} ${ids.join(", ")}, not a start and an end; it is answered as timestamp beside the duration the platform reported.`;
}

export function browsersPendingSentence(rows: Row[]): string | null {
  const waiting = rows.filter((row) => isActiveState(row.status) && Array.isArray(row.browsers) && row.browsers.length === 0);
  if (!waiting.length) return null;

  const named = waiting.map((row) => rowWords(row, `${text(row.status)}${text(row.runningFor) ? ` for ${text(row.runningFor)}` : ""}`));

  return `${named.join(" and ")} ${waiting.length === 1 ? "has" : "have"} no browser reported by the platform yet; browsers land with the build record when the run finishes.`;
}

function newerBuildThanPush(lastPush: Row, commit: string, rows: Row[]): Row | null {
  if (isRow(lastPush.newerBuild) && text(lastPush.newerBuild.buildId)) {
    const given = lastPush.newerBuild;

    return { buildId: text(given.buildId), status: text(given.status), startedAt: isoSeconds(given.startedAt) };
  }

  const newest = rows[0];
  if (!newest || !commit) return null;

  const buildId = text(newest.buildId);
  if (!buildId || buildId.startsWith(commit.slice(0, 7)) || commit.startsWith(buildId.slice(0, 7))) return null;

  const pushedAt = Date.parse(text(lastPush.recordedAt) || text(lastPush.receivedAt));
  const startedAt = Date.parse(text(newest.startedAt));
  if (!Number.isFinite(pushedAt) || !Number.isFinite(startedAt) || startedAt <= pushedAt) return null;

  const number = buildNumberOf(newest);

  return {
    buildId,
    ...(number ? { buildNumber: number } : {}),
    status: text(newest.status),
    startedAt: new Date(startedAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

export function lastPushView(lastPush: Row | null, rows: Row[]): { lastPush: Row | null; sentence: string | null } {
  if (!lastPush) return { lastPush: null, sentence: null };

  const commit = text(lastPush.commit);
  const outcome = text(lastPush.outcome);
  const receivedAt = isoSeconds(lastPush.receivedAt);
  const view: Row = { ...lastPush, ...(receivedAt ? { receivedAt } : {}) };
  const built = commit ? rows.find((row) => text(row.buildId).startsWith(commit.slice(0, 7))) : undefined;

  if (built) {
    const number = buildNumberOf(built);
    view.build = { buildId: text(built.buildId), ...(number ? { buildNumber: number } : {}), status: text(built.status) };
  }

  const newer = newerBuildThanPush(lastPush, commit, rows);

  if (newer) {
    view.stale = true;
    view.newerBuild = newer;
    const words = rowWords(newer, text(newer.status) || "status unknown");

    return {
      lastPush: view,
      sentence: `lastPush is stale: it still names ${commit || "an earlier commit"}${receivedAt ? ` (received ${receivedAt})` : ""}, while ${buildNumberOf(newer) ? words : `build ${words}`} started at ${text(newer.startedAt)}, after that record; the platform has not recorded the push behind ${text(newer.buildId)} yet, so builds[0] is the newest build.`,
    };
  }

  const skipMessage = text(lastPush.message);

  if (lastPush.dispatched === false && SETTINGS_SKIP_OUTCOMES.has(outcome) && skipMessage) {
    return {
      lastPush: view,
      sentence: `The last push the platform received${commit ? `, ${commit}` : ""}${text(lastPush.ref) ? ` to ${text(lastPush.ref)}` : ""}${receivedAt ? ` (received ${receivedAt})` : ""}, was skipped by the project's own settings (${outcome}) and no build row names it: ${skipMessage}`,
    };
  }

  if (lastPush.dispatched !== false || !QUEUED_PUSH_OUTCOMES.has(outcome)) return { lastPush: view, sentence: null };

  const arrived = `The last push${commit ? ` ${commit}` : ""}${receivedAt ? ` (received ${receivedAt})` : ""} was ${outcome.toLowerCase()}`;

  if (built) {
    return {
      lastPush: view,
      sentence: `${arrived}: the platform queued it and then built it, so row ${text(built.buildId)} reads ${text(built.status)}; the push record keeps the outcome it had when the push arrived.`,
    };
  }

  return {
    lastPush: view,
    sentence: `${arrived}: the platform queued it and it folds into the next build it dispatches for ${text(lastPush.ref) || "the branch"}; no build row carries it yet.`,
  };
}

export function headLagView(headLag: Row | null): Row | null {
  if (!headLag) return null;

  const out: Row = { ...headLag };

  for (const key of ["lastBuildAt", "pushReceivedAt"]) {
    if (text(out[key])) out[key] = isoSeconds(out[key]);
  }

  return out;
}
