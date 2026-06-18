// Increasing verbosity; selecting a level includes it + everything more severe.
// Mirrors programs/extension/commands/logs.ts.
const LEVEL_ORDER = ["error", "warn", "info", "debug", "trace"];

function levelRank(level: string): number {
  const l = level === "log" ? "info" : level;
  const i = LEVEL_ORDER.indexOf(l);
  return i === -1 ? LEVEL_ORDER.length : i;
}

export interface LogsArgs {
  projectPath: string;
  browser?: string;
  level?: string;
  context?: string[] | string;
  signalsOnly?: boolean;
  since?: number;
  url?: string;
  tab?: number;
  follow?: boolean;
  followMs?: number;
  limit?: number;
}

// `url` accepts a glob (`*` = any run of chars) or a plain substring. Matched
// against the event's url, then hostname. Mirrors makeUrlMatcher in the CLI
// (programs/extension/commands/logs.ts) — keep the two in lockstep.
function makeUrlMatcher(pattern: string): (event: any) => boolean {
  const hasGlob = pattern.includes("*");
  let re: RegExp | null = null;
  if (hasGlob) {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    re = new RegExp(escaped);
  }
  return (event: any): boolean => {
    const candidates = [event.url, event.hostname].filter(
      (v) => typeof v === "string",
    ) as string[];
    if (candidates.length === 0) return false;
    return candidates.some((c) => (re ? re.test(c) : c.includes(pattern)));
  };
}

export function makeFilter(args: LogsArgs): (event: any) => boolean {
  const minLevel = String(args.level || "all").toLowerCase();
  const rawContexts = Array.isArray(args.context)
    ? args.context
    : typeof args.context === "string"
      ? args.context.split(",")
      : null;
  const contexts =
    rawContexts && rawContexts.length
      ? new Set(rawContexts.map((c) => c.trim()).filter(Boolean))
      : null;
  const sinceSeq = args.since != null ? Number(args.since) : null;
  const urlMatches = args.url ? makeUrlMatcher(args.url) : null;
  const tabId = args.tab != null ? Number(args.tab) : null;

  return (event: any): boolean => {
    if (!event || typeof event !== "object") return false;
    if (event.type === "header") return false;
    if (args.signalsOnly && event.eventType !== "dx.signal") return false;
    if (contexts && !contexts.has(event.context)) return false;
    if (minLevel !== "all" && minLevel !== "off") {
      if (levelRank(event.level) > levelRank(minLevel)) return false;
    }
    if (
      sinceSeq != null &&
      Number.isFinite(sinceSeq) &&
      typeof event.seq === "number" &&
      event.seq <= sinceSeq
    ) {
      return false;
    }
    if (urlMatches && !urlMatches(event)) return false;
    if (tabId != null && Number.isFinite(tabId) && event.tabId !== tabId) {
      return false;
    }
    return true;
  };
}
