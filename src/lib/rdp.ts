// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import type { ConsoleMessage } from "./console-summary";


export interface RdpAddon {
  id?: string;
  actor?: string;
  name?: string;
  version?: string;
  url?: string;
  temporarilyInstalled?: boolean;
  isWebExtension?: boolean;
  isSystem?: boolean;
  hidden?: boolean;
  [key: string]: unknown;
}

export interface RdpTab {
  actor?: string;
  url?: string;
  title?: string;
  selected?: boolean;
  browserId?: number;
  [key: string]: unknown;
}

export function encodeRdpPacket(packet: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(packet), "utf8");

  return Buffer.concat([Buffer.from(`${json.length}:`, "ascii"), json]);
}

export class RdpPacketDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): Array<Record<string, unknown>> {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const packets: Array<Record<string, unknown>> = [];

    for (;;) {
      const colon = this.buffer.indexOf(0x3a);

      if (colon === -1) {
        if (this.buffer.length > 16) {
          throw new Error("RDP stream corrupt: no length prefix");
        }

        break;
      }

      const prefix = this.buffer.subarray(0, colon).toString("ascii");

      if (!/^\d+$/.test(prefix)) {
        throw new Error(`RDP stream corrupt: bad length prefix "${prefix}"`);
      }

      const length = Number(prefix);
      if (this.buffer.length < colon + 1 + length) break;

      const json = this.buffer.subarray(colon + 1, colon + 1 + length);
      this.buffer = this.buffer.subarray(colon + 1 + length);
      packets.push(JSON.parse(json.toString("utf8")));
    }

    return packets;
  }
}

type RdpPacket = Record<string, unknown>;

export class RdpSession {
  private waiters: Array<{
    match: (p: RdpPacket) => boolean;
    resolve: (p: RdpPacket) => void;
    reject: (error: Error) => void;
  }> = [];
  private taps = new Set<(p: RdpPacket) => void>();
  private closed = false;

  private constructor(private socket: net.Socket) {}

  static connect(port: number, timeoutMs = 10_000): Promise<RdpSession> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const session = new RdpSession(socket);
      const decoder = new RdpPacketDecoder();
      let settledConnect = false;

      const timer = setTimeout(() => {
        if (!settledConnect) {
          settledConnect = true;
          session.close();
          reject(new Error(`RDP connect timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      socket.on("data", (chunk) => {
        let packets: RdpPacket[];

        try {
          packets = decoder.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
          );
        } catch {
          session.close();

          return;
        }

        for (const packet of packets) {
          if (!settledConnect && packet.from === "root") {
            settledConnect = true;
            clearTimeout(timer);
            resolve(session);
            continue;
          }

          for (const tap of session.taps) tap(packet);

          for (let i = 0; i < session.waiters.length; i++) {
            if (session.waiters[i].match(packet)) {
              session.waiters.splice(i, 1)[0].resolve(packet);
              break;
            }
          }
        }
      });

      socket.on("error", (error) => {
        if (!settledConnect) {
          settledConnect = true;
          clearTimeout(timer);
          reject(error);
        }
      });

      socket.on("close", () => {
        session.closed = true;

        for (const waiter of session.waiters.splice(0)) {
          waiter.reject(
            new Error("RDP connection closed before a reply arrived"),
          );
        }
      });
    });
  }

  request(
    actor: string,
    packet: RdpPacket,
    timeoutMs = 10_000,
  ): Promise<RdpPacket> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("RDP connection is closed"));

        return;
      }

      const waiter = {
        match: (p: RdpPacket) => p.from === actor && p.type === undefined,
        resolve: (p: RdpPacket) => {
          clearTimeout(timer);

          if (typeof p.error === "string") {
            reject(
              new Error(
                `RDP actor error: ${p.error}${
                  typeof p.message === "string" ? ` (${p.message})` : ""
                }`,
              ),
            );
          } else {
            resolve(p);
          }
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at !== -1) this.waiters.splice(at, 1);

        reject(
          new Error(
            `RDP request ${String(packet.type)} to ${actor} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.waiters.push(waiter);
      this.socket.write(encodeRdpPacket({ to: actor, ...packet }));
    });
  }

  tap(handler: (p: RdpPacket) => void): () => void {
    this.taps.add(handler);

    return () => this.taps.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }
}

async function withSession<T>(
  port: number,
  timeoutMs: number,
  work: (session: RdpSession) => Promise<T>,
): Promise<T> {
  const session = await RdpSession.connect(port, timeoutMs);

  try {
    return await work(session);
  } finally {
    session.close();
  }
}

export async function rdpListAddons(
  port: number,
  options?: { timeoutMs?: number },
): Promise<RdpAddon[]> {
  const timeoutMs = options?.timeoutMs ?? 10_000;

  return withSession(port, timeoutMs, async (session) => {
    const reply = await session.request("root", { type: "listAddons" }, timeoutMs);

    return (reply.addons as RdpAddon[]) ?? [];
  });
}

export async function rdpListTabs(
  port: number,
  options?: { timeoutMs?: number },
): Promise<RdpTab[]> {
  const timeoutMs = options?.timeoutMs ?? 10_000;

  return withSession(port, timeoutMs, async (session) => {
    const reply = await session.request("root", { type: "listTabs" }, timeoutMs);

    return (reply.tabs as RdpTab[]) ?? [];
  });
}

function formatConsoleArg(arg: unknown): string {
  if (arg === null || arg === undefined) return String(arg);

  if (typeof arg === "object") {
    const cls = (arg as Record<string, unknown>).class;

    return typeof cls === "string" ? `[${cls}]` : "[object]";
  }

  return String(arg);
}

export async function rdpCollectConsoleMessages(
  port: number,
  options?: {
    urlFilter?: string;
    timeoutMs?: number;
    settleMs?: number;
  },
): Promise<ConsoleMessage[]> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const settleMs = options?.settleMs ?? 1_000;

  return withSession(port, timeoutMs, async (session) => {
    const tabsReply = await session.request(
      "root",
      { type: "listTabs" },
      timeoutMs,
    );
    const tabs = (tabsReply.tabs as RdpTab[]) ?? [];
    const wanted = options?.urlFilter?.toLowerCase();
    const tab = wanted
      ? tabs.find((t) => String(t.url ?? "").toLowerCase().includes(wanted))
      : (tabs.find((t) => t.selected === true) ?? tabs[0]);

    if (!tab?.actor) {
      throw new Error(
        wanted
          ? `no open tab matches url: ${options?.urlFilter}`
          : "no open tabs",
      );
    }

    const watcherReply = await session.request(
      String(tab.actor),
      { type: "getWatcher", isServerTargetSwitchingEnabled: true },
      timeoutMs,
    );
    const watcherActor = String(watcherReply.actor ?? "");
    if (!watcherActor) throw new Error("tab descriptor returned no watcher");

    const messages: ConsoleMessage[] = [];
    const untap = session.tap((packet) => {
      if (packet.type !== "resources-available-array") return;

      const array = Array.isArray(packet.array) ? packet.array : [];

      for (const entry of array) {
        if (!Array.isArray(entry) || entry.length < 2) continue;

        const [resourceType, resources] = entry as [string, unknown[]];
        if (!Array.isArray(resources)) continue;

        for (const raw of resources) {
          const resource = raw as Record<string, unknown>;

          if (resourceType === "console-message") {
            const args = Array.isArray(resource.arguments)
              ? resource.arguments
              : [];
            messages.push({
              level: String(resource.level ?? "log"),
              text: args.map(formatConsoleArg).join(" "),
            });
          } else if (resourceType === "error-message") {
            const pageError = (resource.pageError ?? {}) as Record<
              string,
              unknown
            >;
            messages.push({
              level: pageError.warning === true ? "warn" : "error",
              text: String(pageError.errorMessage ?? ""),
            });
          }
        }
      }
    });

    try {
      await session.request(
        watcherActor,
        { type: "watchTargets", targetType: "frame" },
        timeoutMs,
      );

      await session.request(
        watcherActor,
        {
          type: "watchResources",
          resourceTypes: ["console-message", "error-message"],
        },
        timeoutMs,
      );

      await sleep(settleMs);
    } finally {
      untap();
    }

    return messages;
  });
}

export type RdpEvalOutcome =
  | { ok: true; value: unknown; tab: { url: string; title: string } }
  | { ok: false; name: string; message: string };

const RDP_EVAL_SLOT = "__extensionDevRdpEval";
const RDP_FRAME_WAIT_MS = 5_000;
const RDP_FRAME_POLL_MS = 50;
const RDP_RESULT_POLL_MS = 100;

/* @invariant A console actor evaluates outside the document's content
   security policy, which is the whole reason to come here: the in-page
   executors (the surface relay, scripting.executeScript, tabs.executeScript
   with a string) are all refused by a policy that forbids eval, the
   extension's own or a site's. It answers an
   object with an actor grip rather than a value and never awaits a promise,
   so the expression is settled inside the document, JSON-encoded there,
   parked under a token and read back as a string. The expression is
   embedded as source, never passed to eval, or the page policy would refuse
   the wrapper for the same reason it refused the relay. */
export function rdpStartExpression(expression: string, token: string): string {
  const key = JSON.stringify(token);

  return `(function () {
  var store = globalThis.${RDP_EVAL_SLOT} = globalThis.${RDP_EVAL_SLOT} || {};
  store[${key}] = { state: "pending" };
  function settle(next) { store[${key}] = next; }
  function encode(value) {
    if (value === undefined) return { state: "value" };
    var json;
    try { json = JSON.stringify(value); } catch (error) { json = undefined; }
    return { state: "value", json: json === undefined ? JSON.stringify(String(value)) : json };
  }
  function thrown(error) {
    return { state: "throw", name: (error && error.name) || "EvalError", message: (error && error.message) || String(error) };
  }
  try {
    Promise.resolve((${expression}
)).then(function (value) { settle(encode(value)); }, function (error) { settle(thrown(error)); });
  } catch (error) {
    settle(thrown(error));
  }
  return "started";
})()`;
}

export function rdpPollExpression(token: string): string {
  const key = JSON.stringify(token);

  return `(function () {
  var store = globalThis.${RDP_EVAL_SLOT};
  var entry = (store && store[${key}]) || null;
  if (entry && entry.state !== "pending") {
    delete store[${key}];
    if (Object.keys(store).length === 0) { try { delete globalThis.${RDP_EVAL_SLOT}; } catch (error) {} }
  }
  var encoded = JSON.stringify(entry);
  return encoded;
})()`;
}

type RdpSettled =
  | { ok: true; value: unknown }
  | { ok: false; name: string; message: string };

export function readRdpEvalSlot(raw: unknown): RdpSettled | "pending" | "lost" {
  if (typeof raw !== "string") return "lost";

  let slot: Record<string, unknown> | null;

  try {
    slot = JSON.parse(raw) as Record<string, unknown> | null;
  } catch {
    return "lost";
  }

  if (!slot || typeof slot !== "object") return "lost";
  if (slot.state === "pending") return "pending";

  if (slot.state === "throw") {
    return {
      ok: false,
      name: typeof slot.name === "string" && slot.name ? slot.name : "EvalError",
      message:
        typeof slot.message === "string" && slot.message
          ? slot.message
          : "the expression threw inside the document",
    };
  }

  if (slot.state !== "value") return "lost";
  if (typeof slot.json !== "string") return { ok: true, value: null };

  try {
    return { ok: true, value: JSON.parse(slot.json) };
  } catch {
    return { ok: true, value: slot.json };
  }
}

function exceptionText(packet: RdpPacket): string {
  const message = packet.exceptionMessage;
  if (typeof message === "string") return message;

  const initial = (message as { initial?: unknown } | null | undefined)?.initial;
  if (typeof initial === "string") return initial;

  return packet.hasException === true ||
    (packet.exception !== undefined && packet.exception !== null)
    ? "the expression threw inside the document"
    : "";
}

/* @invariant A string past Firefox's long-string threshold (10,000
   characters) comes back as a grip holding only its first part, so a
   document's HTML or a large JSON value would read as truncated or as no
   string at all. The grip's own actor hands the rest back. */
async function readStringResult(
  session: RdpSession,
  result: unknown,
  timeoutMs: number,
): Promise<unknown> {
  if (!result || typeof result !== "object") return result;

  const grip = result as Record<string, unknown>;
  if (grip.type !== "longString" || typeof grip.actor !== "string") return result;

  const length = typeof grip.length === "number" ? grip.length : 0;
  const reply = await session.request(
    grip.actor,
    { type: "substring", start: 0, end: length },
    timeoutMs,
  );

  return typeof reply.substring === "string" ? reply.substring : grip.initial;
}

async function consoleEvaluate(
  session: RdpSession,
  consoleActor: string,
  text: string,
  timeoutMs: number,
): Promise<{ result: unknown; threw: string }> {
  const results: RdpPacket[] = [];
  let wake: (() => void) | null = null;
  const untap = session.tap((packet) => {
    if (packet.from !== consoleActor || packet.type !== "evaluationResult") return;

    results.push(packet);
    wake?.();
  });

  try {
    const reply = await session.request(
      consoleActor,
      { type: "evaluateJSAsync", text },
      timeoutMs,
    );
    const resultId = String(reply.resultID ?? "");
    const deadline = Date.now() + timeoutMs;
    const sleepUntilWoken = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);

        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });

    for (;;) {
      const hit = results.find((p) => String(p.resultID ?? "") === resultId);

      if (hit) {
        return {
          result: await readStringResult(session, hit.result, timeoutMs),
          threw: exceptionText(hit),
        };
      }

      const left = deadline - Date.now();

      if (left <= 0) {
        throw new Error(
          `Firefox sent no evaluation result within ${timeoutMs}ms`,
        );
      }

      await sleepUntilWoken(Math.min(left, 250));
      wake = null;
    }
  } finally {
    untap();
  }
}

function topFrameConsoleActor(
  frames: Array<Record<string, unknown>>,
): string | undefined {
  const usable = frames.filter((frame) => typeof frame.consoleActor === "string");
  const top = usable.find((frame) => frame.isTopLevelTarget === true) ?? usable[0];

  return top ? String(top.consoleActor) : undefined;
}

export async function rdpEvaluateInTab(
  port: number,
  options: {
    select: (tabs: RdpTab[]) => RdpTab | null | undefined;
    expression: string;
    timeoutMs?: number;
  },
): Promise<RdpEvalOutcome> {
  const timeoutMs = options.timeoutMs ?? 10_000;

  return withSession(port, timeoutMs, async (session) => {
    const listed = await session.request("root", { type: "listTabs" }, timeoutMs);
    const tab = options.select((listed.tabs as RdpTab[]) ?? []);

    if (!tab?.actor) {
      return { ok: false, name: "TargetNotFound", message: "no open tab matches" };
    }

    const watcher = await session.request(
      String(tab.actor),
      { type: "getWatcher", isServerTargetSwitchingEnabled: true },
      timeoutMs,
    );
    const watcherActor = String(watcher.actor ?? "");

    if (!watcherActor) {
      return {
        ok: false,
        name: "Unsupported",
        message: "this Firefox build exposes no watcher actor for a tab, so the tab cannot be evaluated over the debugger protocol",
      };
    }

    const frames: Array<Record<string, unknown>> = [];
    const untap = session.tap((packet) => {
      if (packet.type !== "target-available-form") return;

      const target = packet.target as Record<string, unknown> | undefined;
      if (target && typeof target === "object") frames.push(target);
    });

    try {
      await session.request(
        watcherActor,
        { type: "watchTargets", targetType: "frame" },
        timeoutMs,
      );

      const frameDeadline = Date.now() + Math.min(timeoutMs, RDP_FRAME_WAIT_MS);
      let consoleActor = topFrameConsoleActor(frames);

      while (!consoleActor && Date.now() < frameDeadline) {
        await sleep(RDP_FRAME_POLL_MS);
        consoleActor = topFrameConsoleActor(frames);
      }

      if (!consoleActor) {
        return {
          ok: false,
          name: "TargetNotFound",
          message: "the tab announced no document to evaluate in (it may still be loading)",
        };
      }

      const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const started = await consoleEvaluate(
        session,
        consoleActor,
        rdpStartExpression(options.expression, token),
        timeoutMs,
      );

      if (started.threw) {
        return { ok: false, name: "EvalError", message: started.threw };
      }

      const resultDeadline = Date.now() + timeoutMs;

      for (;;) {
        const polled = await consoleEvaluate(
          session,
          consoleActor,
          rdpPollExpression(token),
          timeoutMs,
        );
        const settled = readRdpEvalSlot(polled.result);

        if (settled === "lost") {
          return {
            ok: false,
            name: "EvalLost",
            message: "the document reloaded or navigated before the expression settled, so its result is gone",
          };
        }

        if (settled !== "pending") {
          return settled.ok
            ? {
                ok: true,
                value: settled.value,
                tab: { url: String(tab.url ?? ""), title: String(tab.title ?? "") },
              }
            : settled;
        }

        if (Date.now() >= resultDeadline) {
          return {
            ok: false,
            name: "Timeout",
            message: `the expression did not settle within ${timeoutMs}ms`,
          };
        }

        await sleep(RDP_RESULT_POLL_MS);
      }
    } finally {
      untap();
      void session
        .request(watcherActor, { type: "unwatchTargets", targetType: "frame" }, 1_000)
        .catch(() => {});
    }
  });
}
