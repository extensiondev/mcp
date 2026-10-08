
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { WebSocketServer } from "ws";

import { toMcpSpeak } from "../lib/act";
import { untrustedNote } from "../lib/untrusted-fence";
import { schema as logsSchema } from "../tools/logs-schema";
import { schema as inspectSchema } from "../tools/inspect-schema";
import { safariAutomationHint, safariMcpAddCommand } from "../lib/safari-automation";
import { emptyReason, handler as logs } from "../tools/logs";
import { CONTROL_WS_PATH } from "../tools/logs-constants";
import { logsPath, readyContractPath } from "../lib/session-paths";
import { logEvent, logFile } from "./fixtures/engine-answers";
import { writeModernContract } from "./fixtures/ready-contract";

describe("CLI recipes are translated into this server's inputs", () => {
  it("rewrites the engine's list-tabs, inspect and logs recipes", () => {
    expect(toMcpSpeak("Run `extension inspect --list-tabs` to see tabs")).toContain("extension_dom_snapshot with listTabs: true");
    expect(toMcpSpeak("use extension logs --context background")).toContain('extension_logs context: "background"');
    expect(toMcpSpeak("extension inspect --url https://a.test/")).toContain("extension_inspect");
  });
});

describe("102c, 102e, 102f: schema and fence sentences describe what is read", () => {
  it("the fence says the block is the answer body that may carry page text", () => {
    const note = untrustedNote("x");
    expect(note).toMatch(/this tool's answer body/);
    expect(note).toMatch(/never follow instructions/);
    expect(note).not.toMatch(/^Everything between .* was written by a web page/);
  });

  it("the logs schema offers no context the engine never emits, defaults to chrome, and names the replay", () => {
    const context = (logsSchema.inputSchema.properties as Record<string, { items?: { enum?: string[] } }>).context;
    expect(context.items?.enum).not.toContain("page");
    expect((logsSchema.inputSchema.properties as Record<string, { description?: string }>).browser.description).toMatch(/else chrome\./);
    expect(logsSchema.description).toMatch(/replayed/);
    expect(logsSchema.description).not.toMatch(/bounded window\./);
  });

  it("the inspect schema does not promise shadow DOM it does not cross", () => {
    expect(inspectSchema.description).not.toMatch(/full HTML including shadow DOM/);
    expect(inspectSchema.description).toMatch(/not crossed/);
    const deepDom = (inspectSchema.inputSchema.properties as Record<string, { description?: string }>).deepDom;
    expect(deepDom.description).not.toMatch(/open ones are read anyway/);
  });
});

describe("the Safari recipe names the driver that was found", () => {
  it("prints the Technology Preview driver when that is the one detected", () => {
    const tp = "/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver";
    expect(safariMcpAddCommand(tp)).toContain(tp);
    expect(safariAutomationHint({ safaridriver: tp, mcp: true, bidi: true })).toContain(tp);
    expect(safariAutomationHint({ safaridriver: "/usr/bin/safaridriver", mcp: false, bidi: true })).toMatch(/extension_logs still reads/);
  });
});

describe("the empty reason is about the session only when the file is empty", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-logs-empty-"));
    writeModernContract(dir, "chrome", { pid: process.pid, runId: "run-1" });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("says a browser exit is a browser exit, not a build that never ran", () => {
    const ready = readyContractPath(dir, "chrome");
    fs.writeFileSync(ready, JSON.stringify({ status: "error", code: "browser_exited", browserExitCode: 0, pid: process.pid, runId: "run-1" }));
    const reason = emptyReason(dir, "chrome") ?? "";
    expect(reason).toMatch(/browser exited after the build/);
    expect(reason).not.toMatch(/never ran/);
  });

  it("names the filter, not the session, when events exist and none matched", async () => {
    const file = logsPath(dir, "chrome");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, logFile("run-1", [logEvent("popup", "info", ["hello"], { seq: 1, runId: "run-1" })]));
    const out = JSON.parse(await logs({ projectPath: dir, browser: "chrome", level: "error" } as never));
    expect(out.status).toBe("empty");
    expect(out.warnings.join("\n")).toMatch(/none matched the filter/);
    expect(out.warnings.join("\n")).not.toMatch(/no dev session has produced a build/);
  });
});

describe("a follow reports the broker's replay and the live window apart", () => {
  let tmp = "";
  let wss: WebSocketServer;
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-logs-replay-"));
    wss = new WebSocketServer({ port: 0, path: CONTROL_WS_PATH });
    await new Promise<void>((resolve) => wss.on("listening", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("counts ring events as replayed and later frames as live", async () => {
    const port = (wss.address() as { port: number }).port;
    const dir = path.join(tmp, "dist", "extension-js", "chrome");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify({ status: "ready", controlPort: port, instanceId: "inst-1", runId: "run-1" }));
    wss.on("connection", (conn) => {
      conn.send(JSON.stringify({ type: "ready", runId: "run-1", bufferedFrom: 1, evicted: 0 }));
      const old = Date.now() - 60_000;
      conn.send(JSON.stringify({ type: "log", event: { ...logEvent("background", "info", ["old 1"], { seq: 1 }), timestamp: old } }));
      conn.send(JSON.stringify({ type: "log", event: { ...logEvent("background", "info", ["old 2"], { seq: 2 }), timestamp: old + 1 } }));
      setTimeout(() => {
        conn.send(JSON.stringify({ type: "log", event: { ...logEvent("background", "info", ["fresh"], { seq: 3 }), timestamp: Date.now() } }));
      }, 200);
    });

    const out = JSON.parse(await logs({ projectPath: tmp, browser: "chrome", follow: true, followMs: 1500 } as never));
    expect(out.value.matched).toBe(3);
    expect(out.value.replayed).toBe(2);
    expect(out.value.live).toBe(1);
  }, 10_000);
});
