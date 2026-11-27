// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";

import { guidedConnectRuntime, type GuidedConnectRuntime, type LaunchPlan } from "../../lib/guided-connect";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 1)]);

export function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(16);

  head.writeUInt32BE(13, 0);
  head.write("IHDR", 4);
  head.writeUInt32BE(width, 8);
  head.writeUInt32BE(height, 12);

  return Buffer.concat([PNG, head, Buffer.alloc(32)]);
}

export const sha = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

export function sheet(extra: Record<string, unknown> = {}, visibility = "Unlisted") {
  return {
    dashboardUrl: "https://chrome.google.com/webstore/devconsole",
    package: { url: "/pkg", name: "chrome.zip", buildId: "abc1234", sha256: sha(ZIP) },
    left: [{ id: "chrome.item", label: "Chrome Web Store item" }],
    pages: [
      { page: "Store listing", fields: [{ id: "chrome.description", label: "Description", text: "Fills store pages." }], images: [{ id: "chrome.store_icon", files: [{ url: "/icon", name: "chrome-icon-128x128.png" }] }, { id: "chrome.screenshots", files: [{ url: "/shot", name: "chrome-screenshot-1-1280x800.png" }, { url: "/wide", name: "chrome-screenshot-2-1400x800.png" }] }], answers: [] },
      { page: "Privacy", fields: [{ id: "chrome.permission_justifications", label: "Permissions justification", text: "`storage`: keeps the session.\nhttps://*.extension.dev/*: downloads the package." }], images: [], answers: [{ id: "chrome.data_usage", label: "Data usage certifications", kind: "owner-certifies" }] },
      { page: "Distribution", fields: [{ id: "chrome.visibility", label: "Visibility", text: visibility }], images: [], answers: [] },
    ],
    ...extra,
  };
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  const crc = Buffer.alloc(4);

  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "latin1"), body])), 0);

  return Buffer.concat([head, body, crc]);
}

export const served: Record<string, Buffer> = { "/pkg": ZIP, "/icon": png(128, 128), "/shot": png(1280, 800), "/wide": png(1400, 800) };

export function sheetAnswer(status: string, store = "chrome", project = "extension-dev-tools"): string {
  return JSON.stringify({
    ok: true,
    command: "extension_submit",
    status,
    value: { action: "first-submission", store, project: `extensiondev/${project}`, pageUrl: `https://console.extension.dev/extensiondev/${project}/submissions/chrome`, dashboardUrl: null, opened: true, openPages: [{ url: "https://console.extension.dev/x" }] },
    hint: "lane words",
  });
}

export function runtime(launches: LaunchPlan[], tmp: string): GuidedConnectRuntime {
  const binary = (name: string) => `/Applications/${name}.app/Contents/MacOS/${name}`;

  return {
    ...guidedConnectRuntime,
    launchBlock: () => "",
    probe: () => ({ platform: "darwin", systemBinary: (name) => (name === "firefox" || name === "chromium" ? binary(name) : null), managedBinary: () => null, lastUsed: (app) => (app.includes("firefox") ? 9 : 1), defaultBrowser: () => null }),
    fetch: (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
    stateDir: () => tmp,
    cacheDir: () => path.join(tmp, "cache"),
    launch: (plan) => {
      launches.push(plan);

      return { launched: true, reused: false };
    },
    windowCheck: async () => "visible",
    schedule: () => undefined,
  };
}
