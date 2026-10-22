// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { consoleProjectUrl } from "./console-urls";
import { envelope, isEnvelope, type Envelope } from "./envelope";

type Row = Record<string, unknown>;

const STOP = "[^\\s\"'<>()\\[\\]{}`]";
const RUN_URL = new RegExp(`https?://${STOP}*/actions/runs/\\d+${STOP}*`, "gi");
const HOSTED_REPO_URL = new RegExp(`https?://(?:www\\.)?github\\.com/extension-user-land(?:-dev)?/${STOP}*`, "gi");
const HOSTED_REPO = /\bextension-user-land(?:-dev)?\/[\w.-]+/gi;
const HOSTED_SLUG = /\b\d+--prj_[\w-]+/gi;
const RUN_PATH = /\/actions\/runs\/\d+/gi;
const MIRROR_WORD = /\bmirror(s|ed)?\b/gi;
const REGISTRY_URL = new RegExp(
  `https?://(?:registry\\.extension\\.land(?:/${STOP}*)?|${STOP}*/api/(?:local-)?registry/${STOP}*|${STOP}*/_extension-dev(?:-system)?/${STOP}*)`,
  "gi",
);
const REGISTRY_PATH = new RegExp(`(?:\\B/)?\\b_extension-dev(?:-system)?/${STOP}*`, "gi");
const REGISTRY_HOST = /\bregistry\.extension\.land\b/gi;
const WORKFLOW_LEAD = "(?:\\bthe\\s+(?:store\\s+)?(?:workflow\\s+)?)?";
const WORKFLOW_TAIL = "(?:\\s+(?:run|workflow))?";
const WORKFLOW_PATH = new RegExp(`${WORKFLOW_LEAD}\\.github/workflows/${STOP}*?\\.ya?ml\\b${WORKFLOW_TAIL}|\\.github/workflows/${STOP}*`, "gi");
const WORKFLOW_FILE = new RegExp(`${WORKFLOW_LEAD}(?<![\\w/.-])[\\w.-]+\\.yml\\b${WORKFLOW_TAIL}`, "gi");

const INTERNAL_KEYS = new Set(["runId", "workflowRunId", "run_id", "runAttempt", "runCorrelation"]);
const URLISH_KEY = /url$/i;

export const PRIVATE_RUN_PATTERNS = [/extension-user-land(-dev)?\//i, /actions\/runs\//i, /\bmirror\b/i, /\b\d+--prj_/i];

export const PRIVATE_INFRA_PATTERNS = [
  /registry\.extension\.land/i,
  /\/api\/(?:local-)?registry\//i,
  /_extension-dev(?:-system)?\//i,
  /\.github\/workflows\//i,
  /(?<![\w/.-])[\w.-]+\.yml\b/i,
];

const SHA = /^[0-9a-f]{7,40}$/i;

function registryPage(rest: string[]): string {
  const [first = "", second = ""] = rest;
  const file = rest.slice(1).join("/");

  if (/^_extension-dev(?:-system)?$/i.test(first)) {
    if (/^stores\b/i.test(second)) return ConsoleProjectPage.stores;

    if (/^builds\b/i.test(second)) {
      const sha = rest[2] ?? "";

      return SHA.test(sha) ? ConsoleProjectPage.build(sha) : ConsoleProjectPage.builds;
    }

    if (/^(?:channels|releases)\b/i.test(file)) return ConsoleProjectPage.releases;

    return ConsoleProjectPage.overview;
  }

  if (/^builds$/i.test(first)) return SHA.test(second) ? ConsoleProjectPage.build(second) : ConsoleProjectPage.builds;

  return SHA.test(first) ? ConsoleProjectPage.build(first) : ConsoleProjectPage.overview;
}

export function consolePageForRegistryLink(link: string): string {
  let parsed: URL;

  try {
    parsed = new URL(link);
  } catch {
    return consoleProjectUrl(null, "");
  }

  const segments = parsed.pathname
    .replace(/^\/api\/(?:local-)?registry(?=\/)/i, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const [workspace, project, ...rest] = segments;

  if (!workspace || !project || /^_extension-dev/i.test(workspace) || /^_extension-dev/i.test(project)) {
    return consoleProjectUrl(null, "");
  }

  return consoleProjectUrl({ workspace, project }, registryPage(rest));
}

function storeRun(found: string): string {
  return found.startsWith("The") ? "The store run" : "the store run";
}

const DOWNLOAD = /\.(?:zip|xpi|crx)$/i;
const BROWSER_FILE = /\/builds\/[0-9a-f]{7,40}\/(?:artifact-(?:integrity|manifest)\/)?(?:chrome|chromium|edge|firefox|safari)\.json$/i;

function isBuildArtifact(link: string): boolean {
  const pathname = link.split(/[?#]/)[0] ?? "";
  if (/\/_extension-dev(?:-system)?\//i.test(pathname)) return false;

  return DOWNLOAD.test(pathname) || BROWSER_FILE.test(pathname);
}

export function scrubInfraText(input: string): string {
  const kept: string[] = [];
  const held = input.replace(REGISTRY_URL, (link) => {
    const tail = /[.,;:!?]+$/.exec(link)?.[0] ?? "";
    const bare = link.slice(0, link.length - tail.length);

    if (isBuildArtifact(bare)) {
      kept.push(bare);

      return `\u2063${kept.length - 1}\u2063${tail}`;
    }

    return `${consolePageForRegistryLink(bare)}${tail}`;
  });

  return held
    .replace(REGISTRY_PATH, "the project's records")
    .replace(REGISTRY_HOST, "the platform")
    .replace(WORKFLOW_PATH, storeRun)
    .replace(WORKFLOW_FILE, storeRun)
    .replace(/\u2063(\d+)\u2063/g, (_slot, index: string) => kept[Number(index)] ?? "");
}

function isRegistryLink(value: string): boolean {
  const link = value.trim();

  return new RegExp(`^${REGISTRY_URL.source}$`, "i").test(link) && !isBuildArtifact(link);
}

export function scrubRunText(input: string, buildPage?: string): string {
  return scrubInfraText(input)
    .replace(RUN_URL, buildPage || "the build page")
    .replace(HOSTED_REPO_URL, "the project")
    .replace(HOSTED_REPO, "the project")
    .replace(HOSTED_SLUG, "the project")
    .replace(RUN_PATH, "")
    .replace(MIRROR_WORD, (_word, suffix: string | undefined) => (suffix === "s" ? "platform copies" : suffix === "ed" ? "copied" : "platform"));
}

function wholly(value: string): boolean {
  return ["the project", "the build page", "the store run", "the project's records", "the platform", ""].includes(scrubRunText(value).trim());
}

function leaks(value: string): boolean {
  return [...PRIVATE_RUN_PATTERNS, ...PRIVATE_INFRA_PATTERNS].some((pattern) => pattern.test(value));
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
      if (scrubRunText(item) === item) out[key] = item;
      else if (isRegistryLink(item)) out[key] = consolePageForRegistryLink(item.trim());
      else if (page) out[key] = page;

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
