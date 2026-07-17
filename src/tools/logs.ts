import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

import {
  CONTROL_ENVELOPE_VERSION,
  CONTROL_WS_PATH,
  DEFAULT_LIMIT,
  DEFAULT_FOLLOW_MS,
  MIN_FOLLOW_MS,
  MAX_FOLLOW_MS,
} from "./logs-constants";
import { makeFilter, type LogsArgs } from "./logs-filter";
import {
  resolveSessionBrowser,
  knownSessionBrowsers,
} from "../lib/session-browser";

export { schema } from "./logs-schema";

function logsFilePath(projectPath: string, browser: string): string {
  return path.resolve(
    projectPath,
    "dist",
    "extension-js",
    browser,
    "logs.ndjson",
  );
}

function readReadyContract(
  projectPath: string,
  browser: string,
): { controlPort: number; instanceId: string; runId: string } | null {
  const readyPath = path.resolve(
    projectPath,
    "dist",
    "extension-js",
    browser,
    "ready.json",
  );
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

function capRecent(
  events: any[],
  limit: number,
): { events: any[]; truncated: boolean } {
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
    ? out.reduce(
        (m, e) => (typeof e.seq === "number" && e.seq > m ? e.seq : m),
        -1,
      )
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

async function readFromFile(
  args: LogsArgs,
  browser: string,
  limit: number,
): Promise<string> {
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

async function readFromStream(
  args: LogsArgs,
  browser: string,
  limit: number,
): Promise<string> {
  const ready = readReadyContract(args.projectPath, browser);
  if (!ready) {
    const running = knownSessionBrowsers(args.projectPath).filter(
      (b) => b !== browser,
    );
    const retarget = running.length
      ? `An active session exists for browser(s): ${running.join(", ")} — pass that as \`browser\`. Otherwise run`
      : "Run";
    return JSON.stringify({
      error: `No active control channel found for ${browser}.`,
      hint: `${retarget} extension_dev (browser: ${browser}) and wait for it to be ready, then retry. For past logs without a live channel, call without follow.`,
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
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  const limit = args.limit && args.limit > 0 ? args.limit : DEFAULT_LIMIT;

  if (args.follow) {
    return readFromStream(args, browser, limit);
  }
  return readFromFile(args, browser, limit);
}
