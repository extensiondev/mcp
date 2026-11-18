import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyReason, handler } from "../tools/logs";
import { registerSession, removeSession } from "../lib/process-manager";
import { logsPath } from "../lib/session-paths";
import { writeModernContract } from "./fixtures/ready-contract";
import { logEvent, logFile, logGap, logHeader } from "./fixtures/engine-answers";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-logs-file-"));
  writeModernContract(dir, "chrome", { pid: process.pid, runId: "run-1" });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeLog(text: string): void {
  const file = logsPath(dir, "chrome");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

async function read(args: Record<string, unknown> = {}) {
  return JSON.parse(await handler({ projectPath: dir, browser: "chrome", ...args } as never));
}

describe("extension_logs says when the file it read is not the whole run", () => {
  it("names a rotated file and where the earlier events went", async () => {
    writeLog(logFile("run-1", [logEvent("background", "info", ["later"], { seq: 50001 })], "run-1"));

    const out = await read();

    expect(out.status).toBe("read");
    expect(out.value.rotatedFrom).toBe("run-1");
    expect(out.warnings.join(" ")).toContain("rotated");
    expect(out.warnings.join(" ")).toContain("logs.1.ndjson");
  });

  it("counts the events the engine dropped", async () => {
    writeLog(logFile("run-1", [logEvent("background", "info", ["a"], { seq: 1 }), logGap(42)]));

    const out = await read();

    expect(out.value.dropped).toBe(42);
    expect(out.value.total).toBe(1);
    expect(out.warnings.join(" ")).toContain("dropped 42");
  });

  it("says the filter matched nothing when the run holds events", async () => {
    writeLog(logFile("run-1", [logEvent("background", "info", ["fine"], { seq: 1 })]));

    const out = await read({ level: "error" });

    expect(out.status).toBe("empty");
    expect(out.value.total).toBe(1);
    expect(out.warnings.join(" ")).toContain("the filter is");
  });

  it("says a since cursor past the run's newest seq is another run's", async () => {
    writeLog(logFile("run-1", [logEvent("background", "info", ["fine"], { seq: 5 })]));

    const out = await read({ since: 800 });

    expect(out.status).toBe("empty");
    expect(out.warnings.join(" ")).toContain("another run or process");
  });

  it("says a live session with a header-only file has logged nothing yet", async () => {
    writeLog(`${JSON.stringify(logHeader("run-1"))}\n`);

    const out = await read();

    expect(out.status).toBe("empty");
    expect(out.value.total).toBe(0);
    expect(out.warnings.join(" ")).toContain("nothing in the extension has logged");
  });
});

describe("679: extension_logs judges the contract's engine pid by its start time too", () => {
  afterEach(() => {
    removeSession(dir, "chrome");
  });

  it("reads a live pid that started at another time than the recorded session as a past run", async () => {
    registerSession({ pid: process.pid, processStartedAt: "2001-01-01T00:00:00.000Z", browser: "chrome", projectPath: dir, command: "dev" });
    writeLog(logFile("run-1", [logEvent("background", "info", ["old"], { seq: 1 })]));

    const out = await read();

    expect(out.status).toBe("stale");
    expect(out.warnings.join(" ")).toContain("PAST run");
    expect(emptyReason(dir, "chrome")).toContain("the session exited");
  });

  it("keeps a pid whose start time matches the recorded session live", async () => {
    registerSession({ pid: process.pid, browser: "chrome", projectPath: dir, command: "dev" });
    writeLog(logFile("run-1", [logEvent("background", "info", ["now"], { seq: 1 })]));

    const out = await read();

    expect(out.status).toBe("read");
    expect(emptyReason(dir, "chrome")).toBeUndefined();
  });
});

describe("934: Chromium's WebAssembly refusal names a keyword no manifest accepts, so the answer names the right one", () => {
  const REFUSAL =
    "CompileError: WebAssembly.instantiate(): Refused to compile or instantiate WebAssembly module because neither 'wasm-eval' nor 'unsafe-eval' is an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\"";

  it("names 'wasm-unsafe-eval' and the policy value for a refusal logged by a page or the background", async () => {
    writeLog(logFile("run-1", [logEvent("background", "error", [REFUSAL], { seq: 1 })]));

    const out = await read();
    const said = out.warnings.filter((w: string) => w.includes("wasm-unsafe-eval"));

    expect(said).toHaveLength(1);
    expect(said[0]).toContain("'wasm-eval' in that Chromium error is not a manifest keyword: the grant is 'wasm-unsafe-eval'");
    expect(said[0]).toContain('"content_security_policy": { "extension_pages": "script-src \'self\' \'wasm-unsafe-eval\'; object-src \'self\'" }');
  });

  it("says the grant does not reach a content script, and nothing at all for a log without the refusal", async () => {
    writeLog(logFile("run-1", [logEvent("content", "error", [REFUSAL], { seq: 1 })]));

    const content = (await read()).warnings.join(" ");

    expect(content).toContain("the host page's policy");
    expect(content).toContain("compile it in an extension page or the background");

    writeLog(logFile("run-1", [logEvent("background", "error", ["TypeError: x is not a function"], { seq: 1 })]));

    expect((await read()).warnings.join(" ")).not.toContain("wasm");
  });
});
