// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { describe, it, expect, afterEach, vi } from "vitest";

import { encodeRdpPacket, RdpPacketDecoder } from "../lib/rdp";
import { actFailure, actVerbAnswer } from "./fixtures/engine-answers";

import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";

const engineRefusal = () =>
  actVerbAnswer(
    actFailure("open", {
      name: "Unsupported",
      message: "chrome.action not available (engine: firefox)",
      engine: "firefox",
      code: "E_NOT_IMPLEMENTED",
    }),
    "extension_open",
  );

const calls: string[][] = [];
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      calls.push(cli);

      return engineRefusal();
    },
  };
});

let rdpPort: number | null = null;
vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return {
    ...actual,
    resolveCdpPort: async () => null,
    resolveRdpPort: async () =>
      rdpPort === null ? null : { port: rdpPort, source: "contract" as const },
  };
});

const open = await import("../tools/open");

const ADDON_ID = "sidebar@extension.js";
type Packet = Record<string, unknown>;
const servers: net.Server[] = [];
const dirs: string[] = [];

function firefoxParent(): Promise<{ port: number; clicks: Array<{ api: string; addon: string }> }> {
  const clicks: Array<{ api: string; addon: string }> = [];
  const win = { kind: "navigator:browser" };
  const extension = { id: ADDON_ID };
  const actionFor = (api: string) => (ext: { id: string }) => ({
    triggerAction: (w: unknown) => {
      if (w === win) clicks.push({ api, addon: ext.id });
    },
  });
  const context = vm.createContext({
    WebExtensionPolicy: {
      getByID: (id: string) => (id === ADDON_ID ? { extension } : null),
      getByHostname: () => null,
    },
    ChromeUtils: {
      importESModule: (url: string) =>
        url === "resource://gre/modules/ExtensionParent.sys.mjs"
          ? {
              ExtensionParent: {
                apiManager: {
                  global: {
                    browserActionFor: actionFor("browserAction"),
                    pageActionFor: actionFor("pageAction"),
                  },
                },
              },
            }
          : {},
    },
    Services: { wm: { getMostRecentWindow: (type: string) => (type === "navigator:browser" ? win : null) } },
  });
  let nextResult = 0;
  const server = net.createServer((socket) => {
    const decoder = new RdpPacketDecoder();
    const send = (packet: Packet) => socket.write(encodeRdpPacket(packet));
    send({ from: "root", applicationType: "browser" });
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const packet of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        if (packet.type === "getProcess") {
          send({ from: "root", processDescriptor: { actor: "process0", id: 0, isParent: true } });
        } else if (packet.type === "getTarget") {
          send({ from: packet.to, process: { actor: "parent1", consoleActor: "console0" } });
        } else if (packet.type === "evaluateJSAsync") {
          const resultID = `r${nextResult++}`;
          send({ from: "console0", resultID });
          const result = vm.runInContext(String(packet.text), context) as unknown;
          setTimeout(() => send({ from: "console0", type: "evaluationResult", resultID, result }), 0);
        }
      }
    });
  });
  servers.push(server);

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as net.AddressInfo).port, clicks });
    });
  });
}

function project(manifest: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-gecko-toolbar-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", "firefox");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest));

  return dir;
}

const MV2 = {
  manifest_version: 2,
  name: "Sidebar",
  browser_specific_settings: { gecko: { id: ADDON_ID } },
  sidebar_action: { default_panel: "sidebar/index.html" },
  background: { scripts: ["background.js"] },
};

afterEach(async () => {
  calls.length = 0;
  rdpPort = null;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

describe("extension_open surface action on a Firefox MV2 build with a popup-less toolbar button", () => {
  it.each([
    ["browser_action", "browserAction"],
    ["page_action", "pageAction"],
  ])("clicks the %s button through the browser's own toolbar action", async (key, api) => {
    const fake = await firefoxParent();
    rdpPort = fake.port;
    const dir = project({ ...MV2, [key]: { default_title: "Open the sidebar" } });

    const result = JSON.parse(
      await open.handler({ projectPath: dir, browser: "firefox", surface: "action", timeout: 15000 }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("triggered");
    expect(result.value).toMatchObject({ triggered: "onClicked", manifestKey: key });
    expect(fake.clicks).toEqual([{ api, addon: ADDON_ID }]);
    expect(JSON.stringify(result)).not.toContain("declares no action");
  });

  it("names the button it found and only routes that work when the click cannot be replayed", async () => {
    const dir = project({ ...MV2, browser_action: { default_title: "Open the sidebar" } });

    const result = JSON.parse(
      await open.handler({ projectPath: dir, browser: "firefox", surface: "action", timeout: 15000 }),
    );
    const said = JSON.stringify(result);

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("browser_action");
    expect(said).not.toContain("declares no action");
    expect(said).not.toContain("how the extension is built");
    expect(result.hint).toContain('surface: "sidebar"');
    expect(result.hint).toContain('context: "background"');
    expect(said).not.toContain("asTab");
    expect(said).not.toContain("headless: false");
  });
});
