// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import WebSocket from "ws";

import { summarizeConsoleMessages } from "./console-summary";

const COMMAND_TIMEOUT_MS = 15_000;

export class CDPConnection {
  private ws: WebSocket | null = null;
  private messageId = 0;
  private eventListeners = new Set<(msg: Record<string, unknown>) => void>();
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private consoleMessages: Array<{
    level: string;
    text: string;
    source: string;
    timestamp: number;
  }> = [];

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => resolve());

      this.ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on("error", (err: Error) => {
        this.rejectAllPending(err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        this.rejectAllPending("CDP connection closed");
      });
    });
  }

  disconnect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
      }

      this.ws = null;
    }
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as Record<string, unknown>;

      if (typeof message.id === "number") {
        const pending = this.pendingRequests.get(message.id);

        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(message.id);

          if (message.error) {
            pending.reject(new Error(JSON.stringify(message.error)));
          } else {
            pending.resolve(message.result);
          }
        }

        return;
      }

      if (message.method === "Log.entryAdded") {
        const entry = (message.params as Record<string, unknown>)?.entry as
          | Record<string, unknown>
          | undefined;

        if (entry) {
          this.consoleMessages.push({
            level: String(entry.level ?? "info"),
            text: String(entry.text ?? ""),
            source: String(entry.source ?? "other"),
            timestamp: Number(entry.timestamp ?? Date.now()),
          });
        }
      }

      if (message.method === "Runtime.consoleAPICalled") {
        const params = message.params as Record<string, unknown> | undefined;

        if (params) {
          const args = (params.args as Array<Record<string, unknown>>) ?? [];
          const text = args
            .map((a) => String(a.value ?? a.description ?? ""))
            .join(" ");

          this.consoleMessages.push({
            level: String(params.type ?? "log"),
            text,
            source: "console-api",
            timestamp: Number(params.timestamp ?? Date.now()),
          });
        }
      }

      /* @invariant AN UNCAUGHT EXCEPTION IS A CONSOLE ERROR. Chrome reports a
         script that threw at load only as Runtime.exceptionThrown, which no
         collector read, so `console.total` was 0 on a broken page. */
      if (message.method === "Runtime.exceptionThrown") {
        const details = (message.params as Record<string, unknown>)?.exceptionDetails as
          | { text?: unknown; exception?: { description?: unknown }; timestamp?: unknown }
          | undefined;

        if (details) {
          const text = String(details.exception?.description ?? details.text ?? "Uncaught exception");
          this.consoleMessages.push({
            level: "error",
            text,
            source: "exception",
            timestamp: Number((message.params as Record<string, unknown>)?.timestamp ?? Date.now()),
          });
        }
      }

      for (const listener of this.eventListeners) {
        listener(message);
      }
    } catch {
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);

      pending.reject(new Error(reason));

      this.pendingRequests.delete(id);
    }
  }

  async sendCommand(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs: number = COMMAND_TIMEOUT_MS,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("CDP WebSocket is not connected"));
      }

      const id = ++this.messageId;
      const message: Record<string, unknown> = { id, method, params };

      if (sessionId) message.sessionId = sessionId;

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `CDP command timed out (${timeoutMs}ms): ${method}`,
          ),
        );
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify(message));
    });
  }

  getConsoleMessages(): Array<{
    level: string;
    text: string;
    source: string;
    timestamp: number;
  }> {
    return [...this.consoleMessages];
  }

  getConsoleSummary(): Record<string, unknown> {
    return summarizeConsoleMessages(this.consoleMessages);
  }

  resetConsole(): void {
    this.consoleMessages = [];
  }

  protected onEvent(
    handler: (msg: Record<string, unknown>) => void,
  ): () => void {
    this.eventListeners.add(handler);

    return () => {
      this.eventListeners.delete(handler);
    };
  }
}
