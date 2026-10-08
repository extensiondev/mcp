// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import WebSocket from "ws";

import {
  CLOSE_BAD_HELLO,
  CLOSE_BAD_INSTANCE,
  CLOSE_CONTROL_UNAVAILABLE,
  CLOSE_REFUSAL_FLOOR,
  CLOSE_SLOW_CONSUMER,
  CONTROL_ENVELOPE_VERSION,
  CONTROL_WS_PATH,
  DEFAULT_LIMIT,
  DEFAULT_FOLLOW_MS,
  MIN_FOLLOW_MS,
  MAX_FOLLOW_MS,
} from "./logs-constants";
import { makeFilter, type LogsArgs } from "./logs-filter";
import { envelope, type ErrorCode } from "../lib/envelope";
import { WEBKIT_FAMILY } from "../lib/browser-family";
import {
  resolveSessionBrowser,
  knownSessionBrowsers,
} from "../lib/session-browser";
import {
  logsPath,
  readReadyContract,
  readyContractPath,
  sessionPathHint,
  engineProjectRoot,
} from "../lib/session-paths";

export { schema } from "./logs-schema";

const TOOL = "extension_logs";

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

export function emptyReason(
  projectPath: string,
  browser: string,
): string | undefined {
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
    const code = (contract as { code?: unknown }).code;

    if (code === "browser_exited") {
      return `The dev session recorded status:"error" with code browser_exited: the browser exited after the build, so logging stopped when it did. Whatever was written before is in the file; nothing new will arrive until the session is relaunched.`;
    }

    if (errs?.length || code === "compile_error" || code === "first_compile") {
      return `The dev session recorded status:"error"${errs?.length ? ` (${errs.join("; ")})` : ""}, so the extension never ran. There are no logs because there was no working build, not because your code is silent.`;
    }

    return `The dev session recorded status:"error"${typeof code === "string" ? ` (${code})` : ""}, so the extension is not running. Nothing is logging until the session is relaunched.`;
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
  extra: Record<string, unknown> = {},
): string {
  const matched = events.length;
  const { events: out, windowTruncated } = capRecent(events, limit);
  const lastSeq = out.length
    ? out.reduce(
        (m, e) => (typeof e.seq === "number" && e.seq > m ? e.seq : m),
        -1,
      )
    : -1;
  const fileHasEvents = typeof extra.total === "number" && extra.total > 0;
  const reason =
    matched === 0 && projectPath
      ? fileHasEvents
        ? `${extra.total} event(s) are in this run's file and none matched the filter; the session itself is not the reason.`
        : (emptyReason(projectPath, browser) ??
          (typeof extra.total === "number" && extra.total === 0 && source === "file"
            ? "The log file holds no events yet: the session is live and nothing in the extension has logged. Drive it (open a surface, load a page) and read again."
            : undefined))
      : undefined;
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
      ...extra,
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

export function staleFileNote(
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

export function readLogRunId(projectPath: string, browser: string): string {
  let text: string;

  try {
    text = fs.readFileSync(logsPath(projectPath, browser), "utf8");
  } catch {
    return "";
  }

  let runId = "";

  for (const line of text.split("\n")) {
    if (!line) continue;

    let event: { type?: unknown; runId?: unknown };

    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event && event.type === "header" && event.runId) {
      runId = String(event.runId);
    }
  }

  return runId;
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
  let rotatedFrom: string | null = null;
  let dropped = 0;
  let total = 0;
  let maxSeq = -1;
  const events: any[] = [];

  for (const line of lines) {
    let event: any;

    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event && event.type === "header") {
      if (event.runId) runId = String(event.runId);
      if (typeof event.rotatedFrom === "string" && event.rotatedFrom) rotatedFrom = event.rotatedFrom;

      continue;
    }

    if (event && event.type === "gap") {
      dropped += Number(event.dropped) || 0;
      continue;
    }

    total += 1;
    if (typeof event?.seq === "number" && event.seq > maxSeq) maxSeq = event.seq;
    if (matches(event)) events.push(event);
  }

  const notes: string[] = [];

  if (rotatedFrom) {
    notes.push(
      `This file was rotated (it continues run ${rotatedFrom}); earlier events of the run sit in ${path.basename(file).replace(/\.ndjson$/, ".1.ndjson")} and are not in this answer.`,
    );
  }

  if (dropped > 0) {
    notes.push(
      `The engine dropped ${dropped} event(s) it could not write in time (disk_slow); this answer is missing them.`,
    );
  }

  if (events.length === 0 && total > 0) {
    notes.push(
      args.since !== undefined && Number(args.since) > maxSeq
        ? `No event matched: the since cursor ${args.since} is past this run's newest seq (${maxSeq}), so it belongs to another run or process.`
        : `No event matched this filter, but the run holds ${total} event(s); the session is not silent, the filter is.`,
    );
  }

  return summarize(
    events,
    "file",
    browser,
    runId,
    limit,
    dropped,
    args.projectPath,
    staleFileNote(args.projectPath, browser, runId),
    notes.join(" ") || undefined,
    { total, ...(rotatedFrom ? { rotatedFrom } : {}) },
  );
}

export interface ControlRefusal {
  code: ErrorCode;
  status: string;
  message: string;
  hint: string;
}

export function controlRefusal(
  closeCode: number,
  reason: string,
  url: string,
  sentVersion: number,
): ControlRefusal | undefined {
  if (!Number.isFinite(closeCode) || closeCode < CLOSE_REFUSAL_FLOOR) {
    return undefined;
  }

  const said = reason.trim();
  const preamble = `The dev server refused the control channel at ${url}: close code ${closeCode}${said ? ` ("${said}")` : ""}.`;

  if (closeCode === CLOSE_BAD_HELLO) {
    return {
      code: "E_CONTROL_ENVELOPE",
      status: "control-channel-refused",
      message: `${preamble} That code is the broker rejecting the hello frame itself. This MCP dialed as a consumer with control envelope version ${sentVersion}, the version its pinned Extension.js speaks, and the role is one the broker always accepts, so the envelope version is the part that differs: the engine installed in this project is older or newer and speaks a different one. The session may be logging normally even though this read returned nothing.`,
      hint: "Update the project's Extension.js so its control envelope matches this MCP's pinned engine, or read the file instead by calling extension_logs without follow. extension_doctor reports both versions.",
    };
  }

  if (closeCode === CLOSE_BAD_INSTANCE) {
    return {
      code: "E_STALE_CONTRACT",
      status: "control-channel-stale",
      message: `${preamble} That code means the instanceId this MCP sent belongs to a PREVIOUS dev session: the ready.json it read is stale, so the dev server was replaced after that file was written. Nothing here is a version problem, and the engine is not at fault; the session that is running now has an instance this read never named.`,
      hint: "Wait for the current session to publish its contract with extension_wait and retry, or start one with extension_dev if none is running. extension_stop clears a contract left behind by a session that has gone away.",
    };
  }

  if (closeCode === CLOSE_CONTROL_UNAVAILABLE) {
    return {
      code: "E_NO_CONTROL_CHANNEL",
      status: "control-channel-unavailable",
      message: `${preamble} That code is what the pinned broker sends a CONTROLLER when the session runs without allowControl; this reader dialed as a consumer, which that broker never refuses this way, so the engine in this project closes consumers on a rule the pin does not have. Nothing is known about the session's logs from this read.`,
      hint: "Read the file instead by calling extension_logs without follow, and compare the engine versions with extension_doctor; if the project's engine is the pin, relaunch the session with extension_dev and allowControl: true.",
    };
  }

  if (closeCode === CLOSE_SLOW_CONSUMER) {
    return {
      code: "E_CONTROL_CHANNEL",
      status: "control-channel-dropped",
      message: `${preamble} That code means this reader fell far enough behind that the broker dropped it to protect itself. The session, the engine version and the control envelope are all fine: the log volume simply outran this follow window, and whatever came back stops at the moment of the drop rather than at the end of the window.`,
      hint: "Narrow the query before following again (level, context, url or tab), lower followMs, or read the completed file by calling extension_logs without follow.",
    };
  }

  return {
    code: "E_CONTROL_CHANNEL",
    status: "control-channel-refused",
    message: `${preamble} That code is an application-level refusal this MCP does not recognise, so the broker's own reason above is the whole diagnosis. It dialed as a consumer with control envelope version ${sentVersion}, the version its pinned Extension.js speaks; an engine newer than the pin can refuse for reasons this release has never seen.`,
    hint: "Read the file instead by calling extension_logs without follow, and compare the engine versions with extension_doctor.",
  };
}

async function readFromStream(
  args: LogsArgs,
  browser: string,
  limit: number,
): Promise<string> {
  const ready = readReadyContract(engineProjectRoot(args.projectPath), browser);

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
  let connectedAt = Date.now();
  let replayed = 0;
  let liveCount = 0;
  const startedAt = Date.now();
  let opened = false;
  let readySeen = false;
  let bufferedFrom: number | undefined;
  let evicted: number | undefined;

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
          [
            streamNote,
            opened && !readySeen
              ? "The control channel opened but the broker never sent its ready frame, so whether the replay covered the run is unknown."
              : null,
            typeof evicted === "number" && evicted > 0
              ? `The broker's ring had already evicted ${evicted} older event(s) before this read${typeof bufferedFrom === "number" ? ` (it holds from seq ${bufferedFrom})` : ""}; read the file (call without follow) for those.`
              : null,
          ]
            .filter((note): note is string => Boolean(note))
            .join(" ") || undefined,
          {
            replayed,
            live: liveCount,
            followMs,
            opened,
            readySeen,
            ...(typeof bufferedFrom === "number" ? { bufferedFrom } : {}),
            ...(typeof evicted === "number" ? { evicted } : {}),
          },
        ),
      );
    };

    const timer = setTimeout(finish, followMs);

    socket.on("open", () => {
      opened = true;
      connectedAt = Date.now();

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

      if (frame.type === "ready") {
        readySeen = true;
        if (frame.runId) runId = String(frame.runId);
        if (typeof frame.bufferedFrom === "number") bufferedFrom = frame.bufferedFrom;
        if (typeof frame.evicted === "number") evicted = frame.evicted;
      } else if (frame.type === "log" && frame.event) {
        if (matches(frame.event)) {
          events.push(frame.event);
          const at = Number(frame.event.timestamp);
          if (Number.isFinite(at) && at < connectedAt) replayed += 1;
          else liveCount += 1;
        }
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

      const refusal = controlRefusal(
        code,
        reason?.toString() ?? "",
        url,
        CONTROL_ENVELOPE_VERSION,
      );

      if (!refusal) {
        const elapsed = Date.now() - startedAt;

        if (elapsed < followMs - 250) {
          streamNote = `The control channel closed after ${Math.round(elapsed / 1000)} s of the ${Math.round(followMs / 1000)} s window (close code ${code}${reason?.length ? `, "${reason.toString()}"` : ""}), so this is a partial read; the dev session may have stopped or restarted. Re-check with extension_wait.`;
        }

        finish();

        return;
      }

      if (events.length > 0 || dropped > 0) {
        streamNote = refusal.message;
        finish();

        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(
        envelope({
          ok: false,
          command: TOOL,
          status: refusal.status,
          error: {
            code: refusal.code,
            message: refusal.message,
          },
          hint: refusal.hint,
        }),
      );
    });
  });
}

export async function handler(args: LogsArgs): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  const limit = args.limit && args.limit > 0 ? args.limit : DEFAULT_LIMIT;

  if (WEBKIT_FAMILY.has(browser) && !fs.existsSync(logsPath(args.projectPath, browser))) {
    return envelope({
      ok: false,
      command: TOOL,
      status: "no-log-file",
      error: {
        code: "E_LOGS_MISSING",
        message: `No logs found at ${logsPath(args.projectPath, browser)}, and ${browser} has no CDP or RDP to read instead.`,
      },
      hint: "Safari logs arrive through the extension's bridge to the dev server, with background and content contexts, once the extension is enabled and a dev session from an Extension.js that streams Safari logs (4.1.21 or newer) is running. Start extension_dev --browser=safari, enable the extension in Safari > Settings > Extensions, then read again. The page a content script changes is also readable with extension_eval (context: 'page') or extension_assert content-script-injected.",
    });
  }

  if (args.follow) {
    return readFromStream(args, browser, limit);
  }

  return readFromFile(args, browser, limit);
}
