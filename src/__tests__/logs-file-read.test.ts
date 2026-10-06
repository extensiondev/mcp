import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handler } from "../tools/logs";
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
