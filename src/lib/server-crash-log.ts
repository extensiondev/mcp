// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { credentialsPath } from "./credentials";

export const SERVER_LOG_NAME = "mcp-server.log";
export const SERVER_LOG_CAP_BYTES = 1024 * 1024;
export const SERVER_LOG_KEPT_BYTES = 256 * 1024;

export type ServerLogKind = "start" | "crash" | "transport-error" | "exit";

export interface ServerLogRecord {
  at: string;
  kind: ServerLogKind;
  reason: string;
  pid: number;
  version: string;
  uptimeSeconds: number;
  code?: number;
  event?: string;
  error?: { name: string; message: string; code?: string; stack?: string };
  inFlight?: string[];
}

export interface LastServerExit {
  at: string;
  pid: number;
  version: string;
  reason: string;
  recorded: boolean;
  code?: number;
}

export function serverLogPath(): string {
  return path.join(path.dirname(credentialsPath()), SERVER_LOG_NAME);
}

function capLog(file: string): void {
  let size = 0;

  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }

  if (size <= SERVER_LOG_CAP_BYTES) return;

  const text = fs.readFileSync(file, "utf8");
  const tail = text.slice(-SERVER_LOG_KEPT_BYTES);
  const firstLine = tail.indexOf("\n");
  fs.writeFileSync(file, firstLine >= 0 ? tail.slice(firstLine + 1) : "", { mode: 0o600 });
}

export function appendServerLog(record: ServerLogRecord, file: string = serverLogPath()): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    capLog(file);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    return true;
  } catch {
    return false;
  }
}

function readRecords(file: string): ServerLogRecord[] {
  let text = "";

  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const records: ServerLogRecord[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line) as ServerLogRecord;
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") records.push(parsed);
    } catch {
    }
  }

  return records;
}

export function readLastServerExit(
  currentPid: number = process.pid,
  file: string = serverLogPath(),
): LastServerExit | null {
  const records = readRecords(file).filter((record) => record.pid !== currentPid);
  const last = records[records.length - 1];
  if (!last) return null;

  if (last.kind === "exit") {
    return {
      at: last.at,
      pid: last.pid,
      version: last.version,
      reason: last.reason,
      recorded: true,
      ...(typeof last.code === "number" ? { code: last.code } : {}),
    };
  }

  const crash = [...records].reverse().find((record) => record.pid === last.pid && record.kind === "crash");

  return {
    at: last.at,
    pid: last.pid,
    version: last.version,
    reason: `No exit was recorded for server pid ${last.pid}: it was killed without a chance to write one (SIGKILL, out of memory or a closed terminal)${
      crash ? `; its last recorded crash was ${crash.reason}` : ""
    }.`,
    recorded: false,
  };
}

export function errorFields(err: unknown): NonNullable<ServerLogRecord["error"]> {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;

    return {
      name: err.name,
      message: err.message,
      ...(typeof code === "string" ? { code } : {}),
      ...(err.stack ? { stack: err.stack.slice(0, 4000) } : {}),
    };
  }

  return { name: "NonError", message: String(err).slice(0, 4000) };
}

export class ServerCrashError extends Error {
  readonly logPath: string;

  constructor(reason: string, logPath: string) {
    super(`This call was cut short by a crash inside the server (${reason}); the server kept running and wrote the stack to ${logPath}.`);
    this.name = "ServerCrashError";
    this.logPath = logPath;
  }
}

interface InFlightCall {
  tool: string;
  fail: (err: ServerCrashError) => void;
}

const inFlight = new Set<InFlightCall>();

export function inFlightTools(): string[] {
  return [...inFlight].map((call) => call.tool);
}

export function failInFlightCalls(reason: string, logPath: string): number {
  const calls = [...inFlight];

  for (const call of calls) call.fail(new ServerCrashError(reason, logPath));

  return calls.length;
}

export async function watchCall<T>(tool: string, run: () => Promise<T>): Promise<T> {
  let entry: InFlightCall | null = null;
  const crashed = new Promise<never>((_resolve, reject) => {
    entry = { tool, fail: reject };
  });
  crashed.catch(() => undefined);
  const call = entry as unknown as InFlightCall;
  inFlight.add(call);

  try {
    return await Promise.race([run(), crashed]);
  } finally {
    inFlight.delete(call);
  }
}

export function crashAnswerFields(err: unknown): { hint: string; value: { serverLog: string } } | null {
  if (!(err instanceof ServerCrashError)) return null;

  return {
    hint: `The server is still up: call again. If the same call crashes again, read ${err.logPath} for the stack and report it.`,
    value: { serverLog: err.logPath },
  };
}
