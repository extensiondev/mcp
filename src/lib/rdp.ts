// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import net from "node:net";
import type { ConsoleMessage } from "./console-summary";

// Minimal client for Firefox's legacy Remote Debugging Protocol, the server
// behind -start-debugger-server (what about:debugging and web-ext speak).
// Deliberately NOT WebDriver BiDi: BiDi is single-session, and this client must
// be able to attach alongside anything else the session already talks to.
// Implemented surface: root listAddons/listTabs, and the watcher console
// resource replay. Page DOM is never driven through the inspector walker.

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

// A tab descriptor as modern Firefox returns it from root listTabs.
export interface RdpTab {
  actor?: string;
  url?: string;
  title?: string;
  selected?: boolean;
  browserId?: number;
  [key: string]: unknown;
}

// RDP framing: the decimal BYTE length of the JSON payload in ASCII, a colon,
// then the payload. Packets arrive back to back and can split across chunks.
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

// A live RDP connection with request/reply plus an event tap. The wire rule
// that makes correlation safe (verified live): REPLIES carry no `type` field,
// EVENTS always do, and events from an actor can arrive BEFORE that actor's
// reply (watchTargets emits target-available-form first), so "next packet from
// the actor" is not a reply matcher; "next typeless packet from the actor" is.
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
        // A dying connection must fail pending requests, not strand them
        // until their timers fire.
        for (const waiter of session.waiters.splice(0)) {
          waiter.reject(
            new Error("RDP connection closed before a reply arrived"),
          );
        }
      });
    });
  }

  // One request to one actor; resolves with the typeless reply packet, or
  // rejects on an error reply / timeout / closed connection.
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

  // Observe every incoming packet (events included). Returns the untap.
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

// One console-message resource argument, as the watcher serializes it: strings
// come through verbatim, objects as a grip with a `class`.
function formatConsoleArg(arg: unknown): string {
  if (arg === null || arg === undefined) return String(arg);
  if (typeof arg === "object") {
    const cls = (arg as Record<string, unknown>).class;
    return typeof cls === "string" ? `[${cls}]` : "[object]";
  }
  return String(arg);
}

// Collect the tab's console history over RDP. Modern Firefox replays cached
// messages through the watcher's resources API, NOT through the console
// actor's getCachedMessages (verified live: getCachedMessages returns [] while
// a watcher configured with isServerTargetSwitchingEnabled replays everything
// on watchResources, no reload needed). The collection window after the
// watchResources reply exists for stragglers; the replay itself is immediate.
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
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    } finally {
      untap();
    }
    return messages;
  });
}
