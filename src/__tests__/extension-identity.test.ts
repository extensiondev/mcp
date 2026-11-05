// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { unpackedExtensionId } from "../lib/extension-identity";

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function asPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
});

function windowsChrome(): string | null {
  const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA];

  for (const root of roots) {
    if (!root) continue;

    const candidate = path.join(root, "Google", "Chrome", "Application", "chrome.exe");
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

async function chromeLoadsUnpacked(chrome: string, extensionDir: string, profileDir: string): Promise<string> {
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  try {
    return await new Promise<string>((resolve, reject) => {
      let pending = "";
      child.once("error", reject);
      child.stdio[4]!.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        const frames = pending.split("\0");
        pending = frames.pop()!;

        for (const frame of frames) {
          const message = JSON.parse(frame) as { id?: number; result?: { id?: string }; error?: { message?: string } };
          if (message.id !== 1) continue;
          if (message.result?.id) resolve(message.result.id);
          else reject(new Error(message.error?.message ?? frame));
        }
      });

      (child.stdio[3] as NodeJS.WritableStream).write(
        `${JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: extensionDir } })}\0`,
      );
    });
  } finally {
    child.kill();
    await exited;
  }
}

describe("an unpacked extension's id is the one Chromium's GenerateIdForPath derives", () => {
  it("hashes the UTF-8 bytes of the path on POSIX (id_util_unittest.cc vector)", () => {
    asPlatform("linux");
    expect(unpackedExtensionId("/path/to/file.ext")).toBe("lnkgfdknojmdambfcanadbhmfjfljobb");
  });

  it("hashes the UTF-16LE bytes of the path on Windows (id_util_unittest.cc vector)", () => {
    asPlatform("win32");
    expect(unpackedExtensionId("/path/to/file.ext")).toBe("jjlkojfgbeklddcpckipekckcmgcbfjn");
  });

  it("upper-cases a lower-case drive letter on Windows before hashing, and nothing else", () => {
    asPlatform("win32");
    expect(unpackedExtensionId("c:\\Users\\dev\\project\\dist\\chrome")).toBe("bhecfopgogbjkmeaggdocbppkengoeog");
    expect(unpackedExtensionId("C:\\Users\\dev\\project\\dist\\chrome")).toBe("bhecfopgogbjkmeaggdocbppkengoeog");
    expect(unpackedExtensionId("C:\\users\\dev\\project\\dist\\chrome")).not.toBe("bhecfopgogbjkmeaggdocbppkengoeog");
  });

  it.skipIf(process.platform !== "win32" || (!process.env.CI && !windowsChrome()))(
    "matches the id Chrome on Windows assigns when it loads the folder unpacked",
    async () => {
      const chrome = windowsChrome();
      expect(chrome, "Chrome is not installed on this Windows runner").toBeTruthy();

      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-unpacked-id-"));
      const extensionDir = path.join(root, "unpacked-é");
      fs.mkdirSync(extensionDir);
      fs.writeFileSync(
        path.join(extensionDir, "manifest.json"),
        JSON.stringify({ manifest_version: 3, name: "unpacked id", version: "1.0.0" }),
      );

      const lowerDrive = /^[A-Z]:/.test(extensionDir) ? extensionDir[0]!.toLowerCase() + extensionDir.slice(1) : extensionDir;

      try {
        const browserId = await chromeLoadsUnpacked(chrome!, lowerDrive, path.join(root, "profile"));
        expect(browserId).toBe(unpackedExtensionId(lowerDrive));
      } finally {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    },
    90_000,
  );
});
