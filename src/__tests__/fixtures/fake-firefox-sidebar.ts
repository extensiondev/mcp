// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import net from "node:net";
import vm from "node:vm";

import { encodeRdpPacket, RdpPacketDecoder } from "../../lib/rdp";
import { solidPng } from "./png";

export const SIDEBAR_ADDON_ID = "sidebar@extension.js";
export const SIDEBAR_URL = "moz-extension://abc/sidebar/index.html";

type Packet = Record<string, unknown>;

export type FakeFirefoxSidebar = {
  port: number;
  opens: number;
  clicks: Array<{ userInput: boolean }>;
  captures: Array<Record<string, unknown>>;
  sidebarOpen: () => boolean;
  close: () => Promise<void>;
};

export async function fakeFirefoxSidebar(options: { open?: boolean; clickTogglesSidebar?: boolean } = {}): Promise<FakeFirefoxSidebar> {
  const panel = {
    currentURI: { spec: options.open ? SIDEBAR_URL : "about:blank" },
    browsingContext: { id: 77 },
    getBoundingClientRect: () => ({ width: 360.4, height: 700 }),
  };
  const SidebarController = {
    isOpen: options.open === true,
    currentID: options.open ? "sidebar-action" : null,
    browser: { contentDocument: { getElementById: (id: string) => (id === "webext-panels-browser" ? panel : null) } },
  };
  const win = { SidebarController, setTimeout };
  const state = { opens: 0, clicks: [] as Array<{ userInput: boolean }>, captures: [] as Array<Record<string, unknown>> };
  const show = () => {
    state.opens += 1;
    SidebarController.isOpen = true;
    SidebarController.currentID = "sidebar-action";
    setTimeout(() => {
      panel.currentURI.spec = SIDEBAR_URL;
    }, 150);
  };
  const sidebarAction = {
    isOpen: (w: typeof win) => w.SidebarController.isOpen && w.SidebarController.currentID === "sidebar-action",
    open: (w: typeof win) => {
      if (w === win) show();
    },
  };
  const context = vm.createContext({
    WebExtensionPolicy: {
      getByID: (id: string) => (id === SIDEBAR_ADDON_ID ? { extension: { id } } : null),
      getByHostname: () => null,
    },
    ChromeUtils: {
      importESModule: () => ({
        ExtensionParent: {
          apiManager: {
            global: {
              sidebarActionFor: () => sidebarAction,
              browserActionFor: () => ({
                triggerAction: (w: unknown) => {
                  if (w !== win) return;
                  state.clicks.push({ userInput: true });
                  if (options.clickTogglesSidebar) show();
                },
              }),
            },
          },
        },
      }),
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
        } else if (packet.type === "listTabs") {
          send({ from: "root", tabs: [{ actor: "tab0", browsingContextID: 100, url: "https://example.com/", title: "x", selected: true }] });
        } else if (packet.type === "getRoot") {
          send({ from: "root", screenshotActor: "screenshot1" });
        } else if (packet.type === "capture") {
          state.captures.push(packet.args as Record<string, unknown>);
          send({ from: "screenshot1", value: { data: `data:image/png;base64,${solidPng(360, 700).toString("base64")}`, messages: [] } });
        } else if (packet.type === "evaluateJSAsync") {
          const resultID = `r${nextResult++}`;
          send({ from: "console0", resultID });
          const result = vm.runInContext(String(packet.text), context) as unknown;
          setTimeout(() => send({ from: "console0", type: "evaluationResult", resultID, result }), 0);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: (server.address() as net.AddressInfo).port,
    get opens() {
      return state.opens;
    },
    clicks: state.clicks,
    captures: state.captures,
    sidebarOpen: () => sidebarAction.isOpen(win),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
