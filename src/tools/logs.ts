import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

// MCP consumer of the agent-bridge logs plane (Slice 1, read side).
//
// One client, many front-ends: this is the MCP twin of the `extension logs`
// CLI verb (programs/extension/commands/logs.ts). The filter semantics below
// MUST stay in lockstep with that command — same level ordering, same
// context/since/signals-only rules — so an agent and a human see the same
// stream. Default `browser` is `chromium` to match the CLI and the folder a
// default `extension dev` actually writes (dist/extension-js/chromium/).
//
// Bounded by design: a one-shot returns the most recent matching lines (so it
// never floods the agent's context); `follow` collects from the live control
// WS for a short, capped window and returns. There is no infinite stream — an
// agent polls forward with `since`.

// Control-envelope wire constants (control-envelope-1.0.json).
const CONTROL_ENVELOPE_VERSION = 1;
const CONTROL_WS_PATH = "/extjs-control";

const DEFAULT_LIMIT = 200;
const DEFAULT_FOLLOW_MS = 4000;
const MIN_FOLLOW_MS = 500;
const MAX_FOLLOW_MS = 15000;

export const schema = {
  name: "extension_logs",
  description:
    "Read or stream logs from every context of a running dev session (service worker, content scripts, popup, options, sidebar, devtools, pages) in one ordered timeline. Reads the same agent-bridge plane as the `extension logs` CLI: a one-shot returns the most recent matching lines from logs.ndjson; `follow:true` collects from the live control channel for a bounded window. Requires an active `extension dev` session.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root (must have an active dev session)",
      },
      browser: {
        type: "string",
        default: "chromium",
        description:
          "Which dist/extension-js/<browser>/ to read. Defaults to chromium (the default dev target).",
      },
      level: {
        type: "string",
        enum: ["off", "error", "warn", "info", "debug", "trace", "all"],
        default: "all",
        description:
          "Minimum severity to include; selecting a level includes it plus everything more severe.",
      },
      context: {
        type: "array",
        items: {
          type: "string",
          enum: ["background", "content", "page", "sidebar", "popup", "options", "devtools"],
        },
        description: "Restrict to these contexts. Omit for all.",
      },
      signalsOnly: {
        type: "boolean",
        default: false,
        description:
          "Only structured dx.signal diagnostics (which carry code/status/remediation), skipping plain console lines.",
      },
      since: {
        type: "number",
        description: "Only return events with seq greater than this (cursor for polling forward).",
      },
      url: {
        type: "string",
        description:
          "Only events whose url/hostname matches (glob with * or plain substring), e.g. https://shop.example/*.",
      },
      tab: {
        type: "number",
        description: "Only events from this tab id.",
      },
      follow: {
        type: "boolean",
        default: false,
        description:
          "Collect from the live control channel for a bounded window instead of reading the file. Use with followMs.",
      },
      followMs: {
        type: "number",
        default: DEFAULT_FOLLOW_MS,
        description: `How long to collect live frames when follow=true (clamped ${MIN_FOLLOW_MS}–${MAX_FOLLOW_MS}ms).`,
      },
      limit: {
        type: "number",
        default: DEFAULT_LIMIT,
        description: "Maximum number of (most recent) events to return.",
      },
    },
    required: ["projectPath"],
  },
};

// Increasing verbosity; selecting a level includes it + everything more severe.
// Mirrors programs/extension/commands/logs.ts.
const LEVEL_ORDER = ["error", "warn", "info", "debug", "trace"];

function levelRank(level: string): number {
  const l = level === "log" ? "info" : level;
  const i = LEVEL_ORDER.indexOf(l);
  return i === -1 ? LEVEL_ORDER.length : i;
}

interface LogsArgs {
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
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
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

function makeFilter(args: LogsArgs): (event: any) => boolean {
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

function logsFilePath(projectPath: string, browser: string): string {
  return path.resolve(projectPath, "dist", "extension-js", browser, "logs.ndjson");
}

function readReadyContract(
  projectPath: string,
  browser: string,
): { controlPort: number; instanceId: string; runId: string } | null {
  const readyPath = path.resolve(projectPath, "dist", "extension-js", browser, "ready.json");
  try {
    const c = JSON.parse(fs.readFileSync(readyPath, "utf8"));
    if (typeof c.controlPort !== "number" || !c.instanceId) return null;
    return {
      controlPort: c.controlPort,
      instanceId: String(c.instanceId),
      runId: String(c.runId || ""),
    };
  } catch {
    return null;
  }
}

// Trim to the most recent `limit` matches; report whether anything was dropped
// off the front so the caller knows the window was capped (not silently lossy).
function capRecent(events: any[], limit: number): { events: any[]; truncated: boolean } {
  if (events.length <= limit) return { events, truncated: false };
  return { events: events.slice(events.length - limit), truncated: true };
}

function summarize(
  events: any[],
  source: "file" | "stream",
  browser: string,
  runId: string,
  limit: number,
  dropped: number,
): string {
  const matched = events.length;
  const { events: out, truncated } = capRecent(events, limit);
  const lastSeq = out.length
    ? out.reduce((m, e) => (typeof e.seq === "number" && e.seq > m ? e.seq : m), -1)
    : -1;
  return JSON.stringify({
    ok: true,
    source,
    browser,
    runId: runId || undefined,
    matched,
    count: out.length,
    truncated,
    dropped: dropped || undefined,
    nextSince: lastSeq >= 0 ? lastSeq : undefined,
    events: out,
  });
}

async function readFromFile(args: LogsArgs, browser: string, limit: number): Promise<string> {
  const file = logsFilePath(args.projectPath, browser);
  if (!fs.existsSync(file)) {
    return JSON.stringify({
      error: `No logs found at ${file}.`,
      hint: `Start a dev session first (extension_dev), or pass browser to match it. For live frames before any line is written, use follow:true.`,
    });
  }

  const matches = makeFilter(args);
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  let runId = "";
  const events: any[] = [];
  for (const line of lines) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event && event.type === "header" && event.runId) {
      runId = String(event.runId);
      continue;
    }
    if (matches(event)) events.push(event);
  }
  return summarize(events, "file", browser, runId, limit, 0);
}

async function readFromStream(args: LogsArgs, browser: string, limit: number): Promise<string> {
  const ready = readReadyContract(args.projectPath, browser);
  if (!ready) {
    return JSON.stringify({
      error: `No active control channel found for ${browser}.`,
      hint: `Run extension_dev (browser: ${browser}) and wait for it to be ready, then retry. For past logs without a live channel, call without follow.`,
    });
  }

  const followMs = Math.min(
    Math.max(args.followMs ?? DEFAULT_FOLLOW_MS, MIN_FOLLOW_MS),
    MAX_FOLLOW_MS,
  );
  const matches = makeFilter(args);
  const events: any[] = [];
  let dropped = 0;
  let runId = ready.runId;

  return await new Promise<string>((resolve) => {
    let settled = false;
    const url = `ws://127.0.0.1:${ready.controlPort}${CONTROL_WS_PATH}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      resolve(
        JSON.stringify({
          error: `Could not open control channel at ${url}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        }),
      );
      return;
    }

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(summarize(events, "stream", browser, runId, limit, dropped));
    };

    const timer = setTimeout(finish, followMs);

    socket.on("open", () => {
      try {
        socket.send(
          JSON.stringify({
            type: "hello",
            v: CONTROL_ENVELOPE_VERSION,
            role: "consumer",
            instanceId: ready.instanceId,
          }),
        );
      } catch {
        // ignore — timer will settle the call
      }
    });

    socket.on("message", (data: WebSocket.RawData) => {
      let frame: any;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.type === "ready" && frame.runId) {
        runId = String(frame.runId);
      } else if (frame.type === "log" && frame.event) {
        if (matches(frame.event)) events.push(frame.event);
      } else if (frame.type === "gap" && typeof frame.dropped === "number") {
        dropped += frame.dropped;
      }
    });

    socket.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        JSON.stringify({
          error: `Control channel error at ${url}.`,
          hint: "The dev session may have stopped or the control port changed. Re-check with extension_wait.",
        }),
      );
    });

    socket.on("close", finish);
  });
}

export async function handler(args: LogsArgs): Promise<string> {
  const browser = args.browser ?? "chromium";
  const limit = args.limit && args.limit > 0 ? args.limit : DEFAULT_LIMIT;

  if (args.follow) {
    return readFromStream(args, browser, limit);
  }
  return readFromFile(args, browser, limit);
}
