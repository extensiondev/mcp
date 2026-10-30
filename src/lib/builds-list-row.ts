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

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

export function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function word(value: unknown): string {
  return text(value).toLowerCase();
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

function browsersOf(item: Row): string[] {
  return Array.isArray(item.browsers)
    ? item.browsers.map((b) => (isRow(b) ? text(b.browser) || text(b.name) : text(b))).filter(Boolean)
    : [];
}

function withTimes(out: Row, item: Row, active: boolean): void {
  const startedAt = text(item.startedAt || item.timestamp);
  const completedAt = active ? "" : text(item.completedAt);
  const duration = text(item.duration);

  if (startedAt) out.startedAt = startedAt;

  if (active) {
    if (duration) out.runningFor = duration;

    return;
  }

  if (completedAt) out.completedAt = completedAt;
  if (duration) out.duration = duration;
}

export function listRow(item: Row, consoleUrl: (buildId: string) => string): Row {
  const buildId = text(item.buildId) || text(item.shortSha) || text(item.id);
  const state = buildState(item.status, item.conclusion);
  const active = isActiveState(state);
  const browsers = browsersOf(item);
  const out: Row = { buildId };
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
  if (buildId) out.consoleUrl = consoleUrl(buildId);

  return out;
}
