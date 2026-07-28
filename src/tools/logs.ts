// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
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
import { envelope } from "../lib/envelope";
import {
  resolveSessionBrowser,
  knownSessionBrowsers,
} from "../lib/session-browser";
import {
  logsPath,
  readyContractPath,
  sessionPathHint,
} from "../lib/session-paths";

export { schema } from "./logs-schema";

const TOOL = "extension_logs";

function readReadyContract(
  projectPath: string,
  browser: string,
): { controlPort: number; instanceId: string; runId: string } | null {
  const readyPath = readyContractPath(projectPath, browser);
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
): { events: any[]; windowTruncated: boolean } {
  if (events.length <= limit) return { events, windowTruncated: false };
  return {
    events: events.slice(events.length - limit),
    windowTruncated: true,
  };
}

function emptyReason(projectPath: string, browser: string): string | undefined {
  let contract: { status?: string; errors?: string[]; pid?: number };
  try {
    contract = JSON.parse(
      fs.readFileSync(readyContractPath(projectPath, browser), "utf8"),
    );
  } catch {
    return `No ready.json for this project/browser: no dev session has produced a build here, so there is nothing to log. Start one with extension_dev. ${sessionPathHint(readyContractPath(projectPath, browser))}`;
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
  streamNote?: string,
): string {
  const matched = events.length;
  const { events: out, windowTruncated } = capRecent(events, limit);
  const lastSeq = out.length
    ? out.reduce(
        (m, e) => (typeof e.seq === "number" && e.seq > m ? e.seq : m),
        -1,
      )
    : -1;
  const reason =
    matched === 0 && projectPath ? emptyReason(projectPath, browser) : undefined;
  const stale = Boolean(staleNote) && matched > 0;
  return envelope({
    ok: true,
    command: TOOL,
    status: matched === 0 ? "empty" : stale ? "stale" : "read",
    value: {
      source,
      browser,
      runId: runId || undefined,
      matched,
      count: out.length,
      windowTruncated,
      dropped: dropped || undefined,
      nextSince: lastSeq >= 0 ? lastSeq : undefined,
      events: out,
    },
    warnings: [
      reason ?? null,
      stale ? (staleNote ?? null) : null,
      streamNote ?? null,
    ],
  });
}

function staleFileNote(
  projectPath: string,
  browser: string,
  eventsRunId: string,
): string | undefined {
  let contract: { pid?: number; runId?: unknown; instanceId?: unknown };
  try {
    contract = JSON.parse(
      fs.readFileSync(readyContractPath(projectPath, browser), "utf8"),
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
  const file = logsPath(args.projectPath, browser);
  if (!fs.existsSync(file)) {
    return envelope({
      ok: false,
      command: TOOL,
      status: "no-log-file",
      error: {
        code: "E_LOGS_MISSING",
        message: `No logs found at ${file}.`,
      },
      hint: `Start a dev session first (extension_dev), or pass browser to match it. For live frames before any line is written, use follow:true. ${sessionPathHint(file)}`,
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

/* @invariant A close code at or above 4000 is an application-level refusal by
   the engine's broker, not a socket that simply ended. The refusal this package
   can actually cause is an envelope-version mismatch: the broker compares the
   hello's `v` against its own CONTROL_ENVELOPE_VERSION and closes with 4002
   "unsupported envelope version", which happens when the project runs an engine
   older than the one this package pins. Left unhandled, that close resolves the
   follow window as an ordinary empty read, and extension_logs reports "no logs"
   for a session that is logging fine. Reporting the code and the broker's own
   reason verbatim turns a silent wrong answer into a diagnosis. The code is not
   compared against a copied 4002 constant: the engine does not publish its close
   codes on the bridge entry, and a copied number would be the same frozen
   literal this refactor exists to remove. */
export function controlRejectionNote(
  code: number,
  reason: string,
  url: string,
  sentVersion: number,
): string | undefined {
  if (!Number.isFinite(code) || code < 4000) return undefined;
  const said = reason.trim();
  return `The dev server refused the control channel at ${url}: close code ${code}${said ? ` ("${said}")` : ""}. This MCP dialed with control envelope version ${sentVersion}, the version its pinned Extension.js speaks. A refusal here usually means the engine installed in this project is older and speaks a different one; the session may be logging normally even though this read returned nothing. Check the engine version with extension_doctor.`;
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
    return envelope({
      ok: false,
      command: TOOL,
      status: "no-control-channel",
      error: {
        code: "E_NO_CONTROL_CHANNEL",
        message: `No active control channel found for ${browser}.`,
      },
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
        envelope({
          ok: false,
          command: TOOL,
          status: "control-channel-failed",
          error: {
            code: "E_CONTROL_CHANNEL",
            message: `Could not open control channel at ${url}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        }),
      );
      return;
    }

    let streamNote: string | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
      }
      resolve(
        summarize(
          events,
          "stream",
          browser,
          runId,
          limit,
          dropped,
          args.projectPath,
          undefined,
          streamNote,
        ),
      );
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
      if (events.length > 0 || dropped > 0) {
        streamNote = `The control channel at ${url} errored before the follow window ended, so this is a partial read. The dev session may have stopped or the control port changed; re-check with extension_wait.`;
        finish();
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
      }
      resolve(
        envelope({
          ok: false,
          command: TOOL,
          status: "control-channel-failed",
          error: {
            code: "E_CONTROL_CHANNEL",
            message: `Control channel error at ${url}.`,
          },
          hint: "The dev session may have stopped or the control port changed. Re-check with extension_wait.",
        }),
      );
    });

    socket.on("close", (code: number, reason: Buffer) => {
      if (settled) return;
      const refusal = controlRejectionNote(
        code,
        reason?.toString() ?? "",
        url,
        CONTROL_ENVELOPE_VERSION,
      );
      if (!refusal) {
        finish();
        return;
      }
      if (events.length > 0 || dropped > 0) {
        streamNote = refusal;
        finish();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(
        envelope({
          ok: false,
          command: TOOL,
          status: "control-channel-refused",
          error: {
            code: "E_CONTROL_ENVELOPE",
            message: refusal,
          },
          hint: "Update the project's Extension.js so its control envelope matches this MCP's pinned engine, or read the file instead by calling extension_logs without follow.",
        }),
      );
    });
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
