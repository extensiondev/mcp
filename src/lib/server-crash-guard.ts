// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  appendServerLog,
  errorFields,
  failInFlightCalls,
  inFlightTools,
  serverLogPath,
  type ServerLogKind,
  type ServerLogRecord,
} from "./server-crash-log";

type Listener = (...args: any[]) => void;

interface Emitter {
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
}

interface GuardProcess extends Emitter {
  pid: number;
  uptime(): number;
}

interface GuardServer {
  onerror?: (error: Error) => void;
  onclose?: () => void;
}

export interface CrashGuardSetup {
  version: string;
  proc?: GuardProcess;
  stdin?: Emitter;
  stdout?: Emitter;
  stderr?: { write(text: string): unknown };
  server?: GuardServer;
  logPath?: () => string;
  exit?: (code: number) => void;
}

export interface ServerShutdown {
  reason: string;
  code: number;
}

export interface CrashGuard {
  shutdown: Promise<ServerShutdown>;
  uninstall(): void;
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

export function installCrashGuard(setup: CrashGuardSetup): CrashGuard {
  const proc = setup.proc ?? process;
  const stdin = setup.stdin ?? process.stdin;
  const stdout = setup.stdout ?? process.stdout;
  const stderr = setup.stderr ?? process.stderr;
  const logPath = setup.logPath ?? serverLogPath;
  const exit = setup.exit ?? ((code: number) => process.exit(code));
  let exitRecorded = false;
  let shuttingDown = false;
  let resolveShutdown: (value: ServerShutdown) => void = () => undefined;
  const shutdown = new Promise<ServerShutdown>((resolve) => {
    resolveShutdown = resolve;
  });

  const record = (kind: ServerLogKind, reason: string, extra: Partial<ServerLogRecord> = {}): string => {
    const file = logPath();
    appendServerLog(
      {
        at: new Date().toISOString(),
        kind,
        reason,
        pid: proc.pid,
        version: setup.version,
        uptimeSeconds: Math.round(proc.uptime()),
        ...extra,
      },
      file,
    );

    return file;
  };

  const say = (text: string): void => {
    try {
      stderr.write(`[extension-dev MCP ${setup.version} pid ${proc.pid}] ${text}\n`);
    } catch {
    }
  };

  const stop = (reason: string, code: number): void => {
    if (shuttingDown) return;

    shuttingDown = true;
    exitRecorded = true;
    const file = record("exit", reason, { code });
    say(`exiting with code ${code}: ${reason} (recorded in ${file})`);
    resolveShutdown({ reason, code });
    exit(code);
  };

  const crashed = (event: string) => (err: unknown) => {
    const fields = errorFields(err);
    const reason = `${event} ${fields.name}: ${fields.message}`;
    const tools = inFlightTools();
    const file = record("crash", reason, { event, error: fields, inFlight: tools });
    const failed = failInFlightCalls(reason, file);
    say(
      `${reason}; the server keeps serving${failed ? `, ${failed} call(s) in flight (${tools.join(", ")}) answered ok:false` : ""}; stack in ${file}`,
    );

    if (fields.stack) say(fields.stack);
  };

  const onRejection = crashed("unhandledRejection");
  const onException = crashed("uncaughtException");

  const onStdoutError = (err: unknown) => {
    const fields = errorFields(err);
    stop(`stdout to the client failed (${fields.code ?? fields.name}: ${fields.message}); the client closed the pipe`, 1);
  };

  const onStdinEnd = () => stop("the client closed stdin, the end of the MCP stream", 0);

  const onExit = (code: number) => {
    if (exitRecorded) return;

    exitRecorded = true;
    record("exit", `the process exited with code ${code} without a recorded reason (a process.exit call or an empty event loop)`, {
      code,
    });
  };

  const signalHandlers = Object.entries(SIGNALS).map(([signal, number]) => {
    const handler = () => stop(`received ${signal}`, 128 + number);

    return [signal, handler] as const;
  });

  proc.on("unhandledRejection", onRejection);
  proc.on("uncaughtException", onException);
  proc.on("exit", onExit);
  for (const [signal, handler] of signalHandlers) proc.on(signal, handler);
  stdout.on("error", onStdoutError);
  stdin.on("end", onStdinEnd);
  stdin.on("close", onStdinEnd);

  if (setup.server) {
    const previousError = setup.server.onerror;
    const previousClose = setup.server.onclose;

    setup.server.onerror = (error: Error) => {
      previousError?.(error);
      const fields = errorFields(error);
      const file = record("transport-error", `${fields.name}: ${fields.message}`, { error: fields });
      say(`MCP transport error ${fields.name}: ${fields.message} (recorded in ${file})`);
    };

    setup.server.onclose = () => {
      previousClose?.();
      stop("the MCP transport closed", 1);
    };
  }

  record("start", "server started");

  return {
    shutdown,
    uninstall: () => {
      proc.off("unhandledRejection", onRejection);
      proc.off("uncaughtException", onException);
      proc.off("exit", onExit);
      for (const [signal, handler] of signalHandlers) proc.off(signal, handler);
      stdout.off("error", onStdoutError);
      stdin.off("end", onStdinEnd);
      stdin.off("close", onStdinEnd);
    },
  };
}
