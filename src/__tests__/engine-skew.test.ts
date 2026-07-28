import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as bridge from "extension-develop/bridge";
import { handler, controlRejectionNote } from "../tools/logs";
import {
  CONTROL_ENVELOPE_VERSION,
  CONTROL_WS_PATH,
  LOG_EVENT_VERSION,
} from "../tools/logs-constants";
import { readyContractPath, logsPath } from "../lib/session-paths";

describe("control-channel constants come from the engine, not from literals", () => {
  it("re-exports the engine's own wire constants by identity", () => {
    expect(CONTROL_WS_PATH).toBe(bridge.CONTROL_WS_PATH);
    expect(CONTROL_ENVELOPE_VERSION).toBe(bridge.CONTROL_ENVELOPE_VERSION);
    expect(LOG_EVENT_VERSION).toBe(bridge.LOG_EVENT_VERSION);
  });

  it("still describes a usable channel", () => {
    expect(CONTROL_WS_PATH.startsWith("/")).toBe(true);
    expect(Number.isInteger(CONTROL_ENVELOPE_VERSION)).toBe(true);
    expect(Number.isInteger(LOG_EVENT_VERSION)).toBe(true);
  });

  /* A value comparison alone cannot catch a regression here: a re-hardcoded
     "/extjs-control" equals the engine's constant today and the assertion above
     stays green while the coupling is gone. The source is what proves the
     coupling, so this reads it. */
  it("declares them as re-exports, with no literal to drift", () => {
    const source = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "tools",
        "logs-constants.ts",
      ),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    for (const name of [
      "CONTROL_WS_PATH",
      "CONTROL_ENVELOPE_VERSION",
      "LOG_EVENT_VERSION",
    ]) {
      expect(code).not.toMatch(new RegExp(`(const|let|var)\\s+${name}\\s*=`));
    }
    expect(code).toMatch(
      /export\s*\{[^}]*CONTROL_WS_PATH[^}]*\}\s*from\s*["']extension-develop\/bridge["']/s,
    );
  });
});

/* Version skew: this MCP drives whatever engine the project has installed,
   which can be OLDER than the one this package pins. These are the two shapes
   that failure takes, and both must produce a sentence a caller can act on
   rather than an answer that looks correct. */
describe("older engine, different session layout", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-skew-layout-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("names the path it read when a session wrote its logs somewhere else", async () => {
    const legacy = path.join(tmp, "dist", "extension-js-legacy", "chromium");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(
      path.join(legacy, "logs.ndjson"),
      `${JSON.stringify({ context: "background", level: "error", seq: 1 })}\n`,
    );

    const out = JSON.parse(
      await handler({ projectPath: tmp, browser: "chromium" }),
    );

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_LOGS_MISSING");
    expect(out.error.message).toContain(logsPath(tmp, "chromium"));
    expect(out.hint).toContain(logsPath(tmp, "chromium"));
    expect(out.hint).toMatch(/older Extension\.js/);
  });

  it("names the contract path when a matching log file exists but no contract does", async () => {
    const file = logsPath(tmp, "chromium");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ type: "header", runId: "r" })}\n`);

    const out = JSON.parse(
      await handler({ projectPath: tmp, browser: "chromium" }),
    );

    expect(out.ok).toBe(true);
    expect(out.value.matched).toBe(0);
    const warning = (out.warnings as string[]).find((w) =>
      w.includes("No ready.json"),
    );
    expect(warning).toBeDefined();
    expect(warning).toContain(readyContractPath(tmp, "chromium"));
  });
});

describe("older engine, different control envelope", () => {
  it("says nothing about a refusal for an ordinary socket close", () => {
    expect(controlRejectionNote(1000, "", "ws://x", 1)).toBeUndefined();
    expect(controlRejectionNote(1006, "abnormal", "ws://x", 1)).toBeUndefined();
    expect(controlRejectionNote(3999, "", "ws://x", 1)).toBeUndefined();
  });

  it("names the code, the broker's reason and the version it dialed with", () => {
    const note = controlRejectionNote(
      4002,
      "unsupported envelope version",
      "ws://127.0.0.1:9/extjs-control",
      7,
    );
    expect(note).toContain("4002");
    expect(note).toContain("unsupported envelope version");
    expect(note).toContain("ws://127.0.0.1:9/extjs-control");
    expect(note).toContain("version 7");
    expect(note).toMatch(/older/);
  });

  describe("end to end against a broker that rejects the hello", () => {
    let tmp: string;
    let wss: WebSocketServer;

    beforeEach(async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-skew-envelope-"));
      wss = new WebSocketServer({ port: 0, path: CONTROL_WS_PATH });
      await new Promise<void>((resolve) => wss.on("listening", resolve));
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    function writeReady(browser: string, port: number): void {
      const file = readyContractPath(tmp, browser);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          status: "ready",
          controlPort: port,
          instanceId: "inst-1",
          runId: "run-1",
        }),
      );
    }

    it("reports the refusal instead of an empty read", async () => {
      const port = (wss.address() as { port: number }).port;
      writeReady("chromium", port);
      let sawVersion: unknown;
      wss.on("connection", (conn) => {
        conn.on("message", (data) => {
          sawVersion = JSON.parse(data.toString()).v;
          conn.close(4002, "unsupported envelope version");
        });
      });

      const out = JSON.parse(
        await handler({
          projectPath: tmp,
          browser: "chromium",
          follow: true,
          followMs: 6000,
        }),
      );

      expect(sawVersion).toBe(CONTROL_ENVELOPE_VERSION);
      expect(out.ok).toBe(false);
      expect(out.status).toBe("control-channel-refused");
      expect(out.error.code).toBe("E_CONTROL_ENVELOPE");
      expect(out.error.message).toContain("4002");
      expect(out.error.message).toContain("unsupported envelope version");
      expect(out.hint).toContain("without follow");
    }, 15000);

    it("keeps a clean close resolving as an ordinary empty read", async () => {
      const port = (wss.address() as { port: number }).port;
      writeReady("chromium", port);
      wss.on("connection", (conn) => {
        conn.on("message", () => conn.close(1000, "bye"));
      });

      const out = JSON.parse(
        await handler({
          projectPath: tmp,
          browser: "chromium",
          follow: true,
          followMs: 6000,
        }),
      );

      expect(out.ok).toBe(true);
      expect(out.value.matched).toBe(0);
    }, 15000);

    it("still surfaces the refusal as a warning when frames already arrived", async () => {
      const port = (wss.address() as { port: number }).port;
      writeReady("chromium", port);
      wss.on("connection", (conn) => {
        conn.on("message", () => {
          conn.send(
            JSON.stringify({
              type: "log",
              event: { context: "background", level: "info", seq: 4 },
            }),
          );
          setTimeout(() => conn.close(4002, "unsupported envelope version"), 50);
        });
      });

      const out = JSON.parse(
        await handler({
          projectPath: tmp,
          browser: "chromium",
          follow: true,
          followMs: 6000,
        }),
      );

      expect(out.ok).toBe(true);
      expect(out.value.events).toHaveLength(1);
      expect(
        (out.warnings as string[]).some((w) => w.includes("4002")),
      ).toBe(true);
    }, 15000);
  });
});
