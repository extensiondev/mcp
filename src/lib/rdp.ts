// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import net from "node:net";

// Minimal client for Firefox's legacy Remote Debugging Protocol, the server
// behind -start-debugger-server (what about:debugging and web-ext speak).
// Deliberately NOT WebDriver BiDi: BiDi is single-session, and this client must
// be able to attach alongside anything else the session already talks to. Only
// the root actor's listAddons is implemented; add-on targets are never attached.

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

// Connect, wait for the root actor's greeting, send listAddons, and resolve
// with the addon list. Unsolicited root packets (addonListChanged and friends)
// are skipped: only a root reply carrying `addons` — or an error — settles it.
export function rdpListAddons(
  port: number,
  options?: { timeoutMs?: number },
): Promise<RdpAddon[]> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const decoder = new RdpPacketDecoder();
    let greeted = false;
    let settled = false;

    const timer = setTimeout(() => {
      fail(new Error(`RDP listAddons timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function finish(addons: RdpAddon[]) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(addons);
    }

    function fail(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    }

    socket.on("data", (chunk) => {
      let packets: Array<Record<string, unknown>>;
      try {
        packets = decoder.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        );
      } catch (error) {
        fail(error as Error);
        return;
      }
      for (const packet of packets) {
        if (packet.from !== "root") continue;
        if (!greeted) {
          greeted = true;
          socket.write(encodeRdpPacket({ to: "root", type: "listAddons" }));
          continue;
        }
        if (typeof packet.error === "string") {
          fail(
            new Error(
              `RDP root actor error: ${packet.error}${
                typeof packet.message === "string" ? ` (${packet.message})` : ""
              }`,
            ),
          );
          return;
        }
        if (Array.isArray(packet.addons)) {
          finish(packet.addons as RdpAddon[]);
          return;
        }
      }
    });

    socket.on("error", (error) => fail(error));
    socket.on("close", () => {
      fail(new Error("RDP connection closed before listAddons replied"));
    });
  });
}
