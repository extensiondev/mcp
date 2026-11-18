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

import { loadedExtensionIds, sessionGuestIdentity, unpackedExtensionId } from "../lib/extension-identity";
import { keyExtensionId } from "../lib/manifest-key";

import { FIELD_NOTES_ID, FIELD_NOTES_KEY } from "./fixtures/keyed-manifest";

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

describe("a manifest key fixes the id, whatever folder holds the build (ledger 936)", () => {
  function built(manifest: Record<string, unknown>): { project: string; dist: string } {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-keyed-id-"));
    const dist = path.join(project, "dist", "chrome");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Field Notes", version: "2.4.0", ...manifest }));

    return { project, dist };
  }

  it("spells the first 16 bytes of the SHA-256 of the decoded key in a to p, and reads PEM armor as Chromium does", () => {
    expect(keyExtensionId(FIELD_NOTES_KEY)).toBe(FIELD_NOTES_ID);
    expect(keyExtensionId(`-----BEGIN PUBLIC KEY-----\n${FIELD_NOTES_KEY.slice(0, 64)}\n${FIELD_NOTES_KEY.slice(64)}\n-----END PUBLIC KEY-----\n`)).toBe(FIELD_NOTES_ID);
  });

  it("answers no id for a key Chromium refuses, so the folder rule stands", () => {
    expect(keyExtensionId(undefined)).toBeNull();
    expect(keyExtensionId("")).toBeNull();
    expect(keyExtensionId(FIELD_NOTES_KEY.slice(0, -1))).toBeNull();
    expect(keyExtensionId("not base64!")).toBeNull();
  });

  it("derives the loaded id from the built manifest's key and from the folder only when no key is there", () => {
    const keyed = built({ key: FIELD_NOTES_KEY });
    const plain = built({});
    const refused = built({ key: "not base64!" });

    try {
      expect(loadedExtensionIds(keyed.dist)).toEqual([FIELD_NOTES_ID]);
      expect(loadedExtensionIds(plain.dist)).toContain(unpackedExtensionId(plain.dist));
      expect(loadedExtensionIds(plain.dist)).not.toContain(FIELD_NOTES_ID);
      expect(loadedExtensionIds(refused.dist)).toContain(unpackedExtensionId(refused.dist));
    } finally {
      for (const each of [keyed, plain, refused]) fs.rmSync(each.project, { recursive: true, force: true });
    }
  });

  it("expects the key's id of a session whose contract carries no id yet", () => {
    const keyed = built({ key: FIELD_NOTES_KEY });
    const readyDir = path.join(keyed.project, "dist", "extension-js", "chrome");
    fs.mkdirSync(readyDir, { recursive: true });
    fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify({ command: "dev", status: "ready", distPath: keyed.dist }));

    try {
      expect(sessionGuestIdentity(keyed.project, "chrome")).toMatchObject({ expectedIds: [FIELD_NOTES_ID], source: "dist-path" });
    } finally {
      fs.rmSync(keyed.project, { recursive: true, force: true });
    }
  });
});
