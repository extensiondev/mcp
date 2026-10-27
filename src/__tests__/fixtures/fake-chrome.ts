// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import http from "node:http";

import { WebSocketServer } from "ws";

import type net from "node:net";


export interface FakeTarget {
  id: string;
  type: string;
  url: string;
}

export interface FakeCommand {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export const HANG = Symbol("hang");

const realFetch = globalThis.fetch;

export type FakeAnswer = Record<string, unknown> | typeof HANG | undefined;

export interface FakeChrome {
  port: number;
  targets: FakeTarget[];
  commands: FakeCommand[];
  close: () => Promise<void>;
}

export async function startFakeChrome(
  targets: FakeTarget[],
  answer: (command: FakeCommand) => FakeAnswer,
): Promise<FakeChrome> {
  const state: FakeChrome = { port: 0, targets, commands: [], close: async () => {} };
  const server = http.createServer((req, res) => {
    const base = `ws://127.0.0.1:${state.port}/devtools`;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.url === "/json/version"
          ? { Browser: "Chrome/151", webSocketDebuggerUrl: `${base}/browser/b` }
          : state.targets.map((t) => ({ ...t, title: t.url, webSocketDebuggerUrl: `${base}/page/${t.id}` })),
      ),
    );
  });
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
      const command: FakeCommand = { method: message.method, params: message.params ?? {}, ...(message.sessionId ? { sessionId: message.sessionId } : {}) };
      state.commands.push(command);

      const answered = message.method === "Target.attachToTarget"
        ? { sessionId: `S-${String(message.params?.targetId)}` }
        : answer(command);

      if (answered === HANG) return;

      socket.send(JSON.stringify({ id: message.id, result: answered ?? {}, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as net.AddressInfo).port;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.close(() => resolve());
    });

  return state;
}

export function onlyFakeChromeFetch(port: () => number): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(`http://127.0.0.1:${port()}/`)) throw new Error(`this spec reaches only its fake browser, not ${url}`);

    return realFetch(input, init);
  }) as typeof fetch;
}
