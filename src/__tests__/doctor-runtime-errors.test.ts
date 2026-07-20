import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recentErrorLogs } from "../tools/doctor";

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-doctor-logs-"));
  tmpDirs.push(dir);
  return dir;
}

function writeLogs(
  projectPath: string,
  browser: string,
  events: Array<Record<string, unknown>>,
): void {
  const dir = path.join(projectPath, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "logs.ndjson"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

// Mirrors the shape the engine's LogsFileWriter actually emits (LogEvent in
// dev-server/control-bridge/contracts.ts): the payload lives in messageParts.
function engineEvent(
  level: string,
  messageParts: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    id: "evt-1",
    seq: 1,
    timestamp: 1784500000000,
    level,
    context: "background",
    messageParts,
    runId: "run-1",
    ...extra,
  };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("recentErrorLogs", () => {
  it("reads the engine's messageParts payload", () => {
    const project = tmpProject();
    writeLogs(project, "chrome", [
      engineEvent("log", ["booting"]),
      engineEvent("error", [
        "Uncaught TypeError: Cannot read properties of undefined (reading 'get')\nat background.js:12",
      ]),
    ]);

    const errs = recentErrorLogs(project, "chrome");

    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("Uncaught TypeError");
    expect(errs[0]).toContain("background.js:12");
  });

  it("ignores non-error levels", () => {
    const project = tmpProject();
    writeLogs(project, "chrome", [
      engineEvent("log", ["hello"]),
      engineEvent("warn", ["careful"]),
      engineEvent("info", ["fyi"]),
    ]);

    expect(recentErrorLogs(project, "chrome")).toEqual([]);
  });

  it("collapses a throw that repeats on every event", () => {
    const project = tmpProject();
    writeLogs(
      project,
      "chrome",
      Array.from({ length: 20 }, () =>
        engineEvent("error", ["Uncaught TypeError: tabs is undefined"]),
      ),
    );

    expect(recentErrorLogs(project, "chrome")).toEqual([
      "Uncaught TypeError: tabs is undefined",
    ]);
  });

  it("falls back to errorName/stack when messageParts is empty", () => {
    const project = tmpProject();
    writeLogs(project, "chrome", [
      engineEvent("error", [], {
        errorName: "ReferenceError",
        stack: "ReferenceError: browser is not defined\n  at sw.js:3",
      }),
    ]);

    const errs = recentErrorLogs(project, "chrome");

    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("ReferenceError");
  });

  it("stringifies non-string message parts", () => {
    const project = tmpProject();
    writeLogs(project, "chrome", [
      engineEvent("error", ["failed:", { code: 42 }]),
    ]);

    expect(recentErrorLogs(project, "chrome")[0]).toBe('failed: {"code":42}');
  });

  it("survives a header line and malformed rows", () => {
    const project = tmpProject();
    const dir = path.join(project, "dist", "extension-js", "chrome");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "logs.ndjson"),
      [
        JSON.stringify({ v: 1, runId: null, header: true }),
        "not json at all",
        JSON.stringify(engineEvent("error", ["real failure"])),
      ].join("\n") + "\n",
    );

    expect(recentErrorLogs(project, "chrome")).toEqual(["real failure"]);
  });

  it("returns nothing when the session has no log file", () => {
    expect(recentErrorLogs(tmpProject(), "chrome")).toEqual([]);
  });
});
