import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import {
  encodeRdpPacket,
  RdpPacketDecoder,
  rdpListAddons,
  rdpListTabs,
  rdpCollectConsoleMessages,
} from "../lib/rdp";

// Firefox RDP parity (upstream entry 78): the engine now stamps rdpPort into
// ready.json, and the MCP grows this minimal client so list_extensions can ride
// the root actor's listAddons. These tests pin the wire framing (decimal byte
// length, colon, JSON) and the greeting -> listAddons -> addons handshake
// against a real TCP server, chunk splits and unsolicited packets included.

describe("RDP packet framing", () => {
  it("round-trips a packet through encode and decode", () => {
    const decoder = new RdpPacketDecoder();
    const packets = decoder.push(
      encodeRdpPacket({ to: "root", type: "listAddons" }),
    );
    expect(packets).toEqual([{ to: "root", type: "listAddons" }]);
  });

  it("uses the BYTE length for multibyte payloads", () => {
    const encoded = encodeRdpPacket({ name: "café" });
    const json = JSON.stringify({ name: "café" });
    expect(encoded.toString("utf8")).toBe(
      `${Buffer.byteLength(json, "utf8")}:${json}`,
    );
    expect(new RdpPacketDecoder().push(encoded)).toEqual([{ name: "café" }]);
  });

  it("reassembles a packet split across chunks and splits packets in one chunk", () => {
    const decoder = new RdpPacketDecoder();
    const combined = Buffer.concat([
      encodeRdpPacket({ from: "root", seq: 1 }),
      encodeRdpPacket({ from: "root", seq: 2 }),
    ]);
    // Cut mid-first-packet: nothing decodes until the rest arrives, then both
    // packets come out of the second push.
    const cut = 7;
    expect(decoder.push(combined.subarray(0, cut))).toEqual([]);
    expect(decoder.push(combined.subarray(cut))).toEqual([
      { from: "root", seq: 1 },
      { from: "root", seq: 2 },
    ]);
  });

  it("throws on a corrupt length prefix", () => {
    const decoder = new RdpPacketDecoder();
    expect(() => decoder.push(Buffer.from("nope:{}", "utf8"))).toThrow(
      /bad length prefix/,
    );
  });
});

type ServerScript = (
  socket: net.Socket,
  packet: Record<string, unknown> | null,
) => void;

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise((resolve) => server.close(resolve)),
    ),
  );
});

// A scripted RDP server: greets on connect, then hands every decoded client
// packet to the script.
function listen(script: ServerScript): Promise<number> {
  const server = net.createServer((socket) => {
    const decoder = new RdpPacketDecoder();
    socket.write(
      encodeRdpPacket({ from: "root", applicationType: "browser" }),
    );
    script(socket, null);
    socket.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const packet of decoder.push(buf)) script(socket, packet);
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

const ADDONS = [
  {
    id: "probe@extension.dev",
    name: "RDP Probe",
    version: "1.0.0",
    temporarilyInstalled: true,
    isWebExtension: true,
  },
];

describe("rdpListAddons", () => {
  it("greets, requests listAddons, and resolves the addon list", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const port = await listen((socket, packet) => {
      if (!packet) return;
      requests.push(packet);
      if (packet.type === "listAddons") {
        socket.write(encodeRdpPacket({ from: "root", addons: ADDONS }));
      }
    });

    await expect(rdpListAddons(port)).resolves.toEqual(ADDONS);
    expect(requests).toEqual([{ to: "root", type: "listAddons" }]);
  });

  it("skips unsolicited root packets while waiting for the addons reply", async () => {
    const port = await listen((socket, packet) => {
      if (packet?.type !== "listAddons") return;
      socket.write(
        encodeRdpPacket({ from: "root", type: "addonListChanged" }),
      );
      socket.write(encodeRdpPacket({ from: "root", addons: ADDONS }));
    });

    await expect(rdpListAddons(port)).resolves.toEqual(ADDONS);
  });

  it("rejects on a root actor error reply", async () => {
    const port = await listen((socket, packet) => {
      if (packet?.type !== "listAddons") return;
      socket.write(
        encodeRdpPacket({
          from: "root",
          error: "unrecognizedPacketType",
          message: "no listAddons here",
        }),
      );
    });

    await expect(rdpListAddons(port)).rejects.toThrow(
      /unrecognizedPacketType.*no listAddons here/,
    );
  });

  it("rejects when the server goes silent past the timeout", async () => {
    const port = await listen(() => {});
    await expect(
      rdpListAddons(port, { timeoutMs: 300 }),
    ).rejects.toThrow(/timed out/);
  });

  it("rejects when the connection closes before a reply", async () => {
    const port = await listen((socket, packet) => {
      if (packet?.type === "listAddons") socket.end();
    });
    await expect(rdpListAddons(port)).rejects.toThrow(/closed before/);
  });
});

describe("rdpCollectConsoleMessages", () => {
  // The flow verified live: getWatcher (configured) -> watchTargets ->
  // watchResources, with the cached console history replayed as
  // resources-available-array packets. watchTargets emits its
  // target-available-form event BEFORE its own reply, which is exactly why
  // replies are matched as typeless packets.
  it("collects the watcher replay, events-before-reply ordering included", async () => {
    const port = await listen((socket, packet) => {
      if (!packet) return;
      if (packet.type === "listTabs") {
        socket.write(
          encodeRdpPacket({
            from: "root",
            tabs: [
              { actor: "tab1", url: "https://example.com/", selected: true },
            ],
          }),
        );
      }
      if (packet.type === "getWatcher" && packet.to === "tab1") {
        socket.write(encodeRdpPacket({ from: "tab1", actor: "watcher1" }));
      }
      if (packet.type === "watchTargets") {
        socket.write(
          encodeRdpPacket({
            from: "watcher1",
            type: "target-available-form",
            target: {},
          }),
        );
        socket.write(encodeRdpPacket({ from: "watcher1" }));
      }
      if (packet.type === "watchResources") {
        socket.write(
          encodeRdpPacket({
            from: "target1",
            type: "resources-available-array",
            array: [
              [
                "console-message",
                [
                  { arguments: ["hello", { class: "Object" }], level: "log" },
                  { arguments: [42], level: "warn" },
                ],
              ],
              [
                "error-message",
                [{ pageError: { errorMessage: "boom", warning: false } }],
              ],
            ],
          }),
        );
        socket.write(encodeRdpPacket({ from: "watcher1" }));
      }
    });

    const messages = await rdpCollectConsoleMessages(port, { settleMs: 100 });
    expect(messages).toEqual([
      { level: "log", text: "hello [Object]" },
      { level: "warn", text: "42" },
      { level: "error", text: "boom" },
    ]);
  });

  it("rejects when no tab matches the url filter", async () => {
    const port = await listen((socket, packet) => {
      if (packet?.type === "listTabs") {
        socket.write(
          encodeRdpPacket({
            from: "root",
            tabs: [{ actor: "tab1", url: "about:blank" }],
          }),
        );
      }
    });

    await expect(
      rdpCollectConsoleMessages(port, { urlFilter: "example.com" }),
    ).rejects.toThrow(/no open tab matches/);
  });
});

describe("rdpListTabs", () => {
  it("requests listTabs and resolves the tab descriptor list", async () => {
    const tabs = [
      { actor: "server1.conn0.tabDescriptor4", url: "https://example.com/", title: "Example", selected: true },
    ];
    const requests: Array<Record<string, unknown>> = [];
    const port = await listen((socket, packet) => {
      if (!packet) return;
      requests.push(packet);
      if (packet.type === "listTabs") {
        socket.write(encodeRdpPacket({ from: "root", tabs }));
      }
    });

    await expect(rdpListTabs(port)).resolves.toEqual(tabs);
    expect(requests).toEqual([{ to: "root", type: "listTabs" }]);
  });
});
