// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handler } from "../tools/wait";
import {
  registerSession,
  removeSession,
  removeSessionMarker,
} from "../lib/process-manager";
import { notAttachedHint } from "../lib/safari-dev-options";
import { writeCompiledUnattachedContract } from "./fixtures/ready-contract";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wait-safari-"));
});

afterEach(() => {
  for (const browser of ["chrome", "safari"]) {
    removeSession(dir, browser);
    removeSessionMarker(dir, browser);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_wait names the Safari enable step when a Safari session never attaches", () => {
  it("says the extension is not enabled in Safari yet and names enableExtension and the one-time setup", async () => {
    registerSession({ pid: process.pid, browser: "safari", projectPath: dir, command: "dev" });
    writeCompiledUnattachedContract(dir, "safari", { pid: process.pid });

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "safari", timeoutMs: 1500 }),
    );

    expect(result.status).toBe("compiled-not-attached");
    expect(result.error.code).toBe("E_NOT_ATTACHED");
    expect(result.hint).toContain("The extension is not enabled in Safari yet");
    expect(result.hint).toContain("enableExtension: true and replace: true");
    expect(result.hint).toContain("Safari > Settings > Extensions > turn the extension on");
    expect(result.hint).toContain("This is not a transient attach failure");
    expect(result.hint).not.toContain("usually transient");
  }, 10_000);

  it("names the Accessibility grant when the session was started with enableExtension", async () => {
    registerSession({ pid: process.pid, browser: "safari", projectPath: dir, command: "dev", enableExtension: true });
    writeCompiledUnattachedContract(dir, "safari", { pid: process.pid });

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "safari", timeoutMs: 1500 }),
    );

    expect(result.status).toBe("compiled-not-attached");
    expect(result.hint).toContain("The extension is not enabled in Safari yet");
    expect(result.hint).toContain("started with enableExtension: true");
    expect(result.hint).toContain("System Settings > Privacy & Security > Accessibility");
    expect(result.hint).toContain("extension_logs");
    expect(result.hint).not.toContain("usually transient");
  }, 10_000);

  it("keeps the transient advice for a Chromium session", async () => {
    registerSession({ pid: process.pid, browser: "chrome", projectPath: dir, command: "dev" });
    writeCompiledUnattachedContract(dir, "chrome", { pid: process.pid });

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }),
    );

    expect(result.status).toBe("compiled-not-attached");
    expect(result.hint).toContain("This is usually transient: call extension_wait again");
    expect(result.hint).not.toContain("Safari");
  }, 10_000);

  it("writes the same sentence for webkit-based as for safari, and the generic one for everything else", () => {
    expect(notAttachedHint("webkit-based", false)).toBe(notAttachedHint("safari", false));
    expect(notAttachedHint("firefox", true)).toBe(notAttachedHint("chrome", false));
    expect(notAttachedHint("safari", true)).not.toBe(notAttachedHint("safari", false));
  });
});
