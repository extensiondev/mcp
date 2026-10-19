// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope, isEnvelope, type Envelope } from "./envelope";

type Row = Record<string, unknown>;

const STOP = "[^\\s\"'<>()\\[\\]{}`]";
const RUN_URL = new RegExp(`https?://${STOP}*/actions/runs/\\d+${STOP}*`, "gi");
const HOSTED_REPO_URL = new RegExp(`https?://(?:www\\.)?github\\.com/extension-user-land(?:-dev)?/${STOP}*`, "gi");
const HOSTED_REPO = /\bextension-user-land(?:-dev)?\/[\w.-]+/gi;
const HOSTED_SLUG = /\b\d+--prj_[\w-]+/gi;
const RUN_PATH = /\/actions\/runs\/\d+/gi;
const MIRROR_WORD = /\bmirror(s|ed)?\b/gi;

const INTERNAL_KEYS = new Set(["runId", "workflowRunId", "run_id", "runAttempt", "runCorrelation"]);
const URLISH_KEY = /url$/i;

export const PRIVATE_RUN_PATTERNS = [/extension-user-land(-dev)?\//i, /actions\/runs\//i, /\bmirror\b/i, /\b\d+--prj_/i];

export function scrubRunText(input: string, buildPage?: string): string {
  return input
    .replace(RUN_URL, buildPage || "the build page")
    .replace(HOSTED_REPO_URL, "the project")
    .replace(HOSTED_REPO, "the project")
    .replace(HOSTED_SLUG, "the project")
    .replace(RUN_PATH, "")
    .replace(MIRROR_WORD, (_word, suffix: string | undefined) => (suffix === "s" ? "platform copies" : suffix === "ed" ? "copied" : "platform"));
}

function wholly(value: string): boolean {
  return ["the project", "the build page", ""].includes(scrubRunText(value).trim());
}

function leaks(value: string): boolean {
  return PRIVATE_RUN_PATTERNS.some((pattern) => pattern.test(value));
}

const RUN_RECORD_KEYS = new Set(["run", "workflowRun", "workflow_run"]);
const RUN_RECORD_ID_KEYS = new Set(["id", "number", "runNumber", "run_number"]);
const BUILD_PAGE = /\/builds\/[^/?#\s]+/;

function ownBuildPage(row: Row): string | undefined {
  return [row.trackUrl, row.consoleUrl].find(
    (url): url is string => typeof url === "string" && BUILD_PAGE.test(url) && !leaks(url),
  );
}

function scrubValue(value: unknown, buildPage: string | undefined, inInternal: boolean, inRun = false): unknown {
  if (typeof value === "string") return leaks(value) ? scrubRunText(value, buildPage) : value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, buildPage, inInternal));
  if (!value || typeof value !== "object") return value;

  const row = value as Row;
  const page = ownBuildPage(row) ?? buildPage;
  const out: Row = {};

  for (const [key, item] of Object.entries(row)) {
    if (!inInternal && INTERNAL_KEYS.has(key)) continue;
    if (!inInternal && inRun && RUN_RECORD_ID_KEYS.has(key)) continue;

    if (typeof item === "string" && leaks(item) && URLISH_KEY.test(key)) {
      if (page) out[key] = page;

      continue;
    }

    if (typeof item === "string" && leaks(item) && wholly(item)) continue;

    out[key] = scrubValue(item, page, inInternal || key === "internal", RUN_RECORD_KEYS.has(key));
  }

  return out;
}

function buildPageOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const row = value as Row;
  const links = Array.isArray(row.trackLinks) ? row.trackLinks : [];
  const candidates = [row.trackUrl, ...links, row.consoleUrl, (row.build as Row | undefined)?.consoleUrl];

  return candidates.find((url): url is string => typeof url === "string" && BUILD_PAGE.test(url));
}

export function scrubRunAnswer(result: string): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(result);
  } catch {
    return leaks(result) ? scrubRunText(result) : result;
  }

  if (!isEnvelope(parsed) || !leaks(result)) return result;

  const frame = parsed as Envelope;
  const buildPage = buildPageOf(frame.value);
  const error = frame.error ? (scrubValue(frame.error, buildPage, false) as Envelope["error"]) : null;

  return envelope({
    ok: frame.ok,
    command: frame.command,
    status: frame.status,
    value: scrubValue(frame.value, buildPage, false),
    error,
    warnings: frame.warnings.map((warning) => scrubRunText(warning, buildPage)),
    ...(frame.truncated !== undefined ? { truncated: frame.truncated } : {}),
    ...(typeof frame.hint === "string" ? { hint: scrubRunText(frame.hint, buildPage) } : {}),
  });
}
