// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

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

// When a log read comes back EMPTY, say WHY. extension_logs is the first tool
// reached for when nothing happens, and returning ok:true/matched:0 for a dead
// session or a build that never compiled reads as "your extension ran and
// logged nothing" rather than "there was nothing to log". Four of fifteen
// personas in the API-surface swarm were misled by exactly this.
function emptyReason(projectPath: string, browser: string): string | undefined {
  // Deliberately NOT readReadyContract above: that one narrows the contract to
  // {controlPort, instanceId, runId} and returns null when a control channel is
  // absent, which is exactly the dead-session case we need to explain here.
  let contract: { status?: string; errors?: string[]; pid?: number };
  try {
    contract = JSON.parse(
      fs.readFileSync(
        path.resolve(projectPath, "dist", "extension-js", browser, "ready.json"),
        "utf8",
      ),
    );
  } catch {
    return "No ready.json for this project/browser: no dev session has produced a build here, so there is nothing to log. Start one with extension_dev.";
  }
  if (contract.status === "error") {
    const errs = contract.errors;
    return `The dev session recorded status:"error"${errs?.length ? ` (${errs.join("; ")})` : ""}, so the extension never ran. There are no logs because there was no working build, not because your code is silent.`;
  }
  if (typeof contract.pid === "number") {
    try {
      process.kill(contract.pid, 0);
    } catch {
      return `ready.json reports ready but its dev-server pid ${contract.pid} is dead: the session exited. Logs stop at the moment it died. Restart with extension_dev; extension_doctor will confirm.`;
    }
  }
  return undefined;
}

function summarize(
  events: any[],
  source: "file" | "stream",
  browser: string,
  runId: string,
  limit: number,
  dropped: number,
  projectPath?: string,
  staleNote?: string,
): string {
  const matched = events.length;
  const { events: out, truncated } = capRecent(events, limit);
  const lastSeq = out.length
    ? out.reduce(
        (m, e) => (typeof e.seq === "number" && e.seq > m ? e.seq : m),
        -1,
      )
    : -1;
  const reason =
    matched === 0 && projectPath ? emptyReason(projectPath, browser) : undefined;
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
    ...(reason ? { emptyReason: reason } : {}),
    ...(staleNote && matched > 0 ? { stale: true, warning: staleNote } : {}),
    events: out,
  });
}

// D20 in the API-surface swarm verified a production build with
// extension_start and read the PREVIOUS dev run's events back as fresh
// ok:true output. The events file outlives its session; serving history is
// fine, serving it as if it were live is not. Detect a dead or different
// producing session and say so.
function staleFileNote(
  projectPath: string,
  browser: string,
  eventsRunId: string,
): string | undefined {
  let contract: { pid?: number; runId?: unknown; instanceId?: unknown };
  try {
    contract = JSON.parse(
      fs.readFileSync(
        path.resolve(projectPath, "dist", "extension-js", browser, "ready.json"),
        "utf8",
      ),
    );
  } catch {
    return "These events survive from a previous session: no ready.json exists for this project/browser now, so nothing current is producing logs.";
  }
  if (typeof contract.pid === "number") {
    try {
      process.kill(contract.pid, 0);
    } catch {
      return `These events are from a PAST run: the session that wrote them (pid ${contract.pid}) is dead. Nothing current is producing logs; do not read these as live output.`;
    }
  }
  // The engine stamps events with its own id, which depending on the engine
  // version is ready.json's runId OR its instanceId (newer canaries write
  // instanceId). Treat a match against EITHER as the live session; flagging a
  // healthy session as stale is the same lie D20 caught, inverted.
  const liveIds = [contract.runId, contract.instanceId]
    .map((v) => String(v || ""))
    .filter(Boolean);
  if (eventsRunId && liveIds.length > 0 && !liveIds.includes(eventsRunId)) {
    return `These events carry runId ${eventsRunId} but the current session is run ${liveIds.join(" / ")}, which has written nothing yet. Do not read these as the current run's output.`;
  }
  return undefined;
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
  return summarize(
    events,
    "file",
    browser,
    runId,
    limit,
    0,
    args.projectPath,
    staleFileNote(args.projectPath, browser, runId),
  );
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
      ? `An active session exists for browser(s): ${running.join(", ")}, pass that as \`browser\`. Otherwise run`
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
      resolve(summarize(events, "stream", browser, runId, limit, dropped, args.projectPath));
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
