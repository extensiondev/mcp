import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serverInstructions } from "../index";
import { ENGINE_BIN_ENV, ENGINE_DIR_ENV } from "../lib/engine-override";
import { envelopeObject } from "../lib/envelope";
import { logsPath } from "../lib/session-paths";
import { handler as logs } from "../tools/logs";
import { logEvent, logFile } from "./fixtures/engine-answers";
import { writeModernContract } from "./fixtures/ready-contract";

const saved = {
  dir: process.env[ENGINE_DIR_ENV],
  bin: process.env[ENGINE_BIN_ENV],
};
const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);

  return dir;
}

function putEngine(dir: string): void {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "extension.cjs"), 'console.log("[]");\n');
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "extension", version: "4.1.38" }));
}

function liveProject(): string {
  const project = tmp("mcp-dead-override-project-");
  writeModernContract(project, "chrome", { pid: process.pid, runId: "run-1" });
  const file = logsPath(project, "chrome");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, logFile("run-1", [logEvent("background", "info", ["hello"])], "run-1"));

  return project;
}

function dead(dir: string, env = ENGINE_DIR_ENV): string {
  return `${env}=${dir} names no engine bin; fix or unset it before extension_dev, extension_build or extension_start`;
}

function overrideLines(warnings: string[]): string[] {
  return warnings.filter((line) => line.includes("names no engine bin"));
}

afterEach(() => {
  for (const [key, value] of [
    [ENGINE_DIR_ENV, saved.dir],
    [ENGINE_BIN_ENV, saved.bin],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("440: a dead EXTENSION_MCP_ENGINE_DIR warns on every answer, not only the one that spawns", () => {
  it("a read tool's ok answer carries the one line while the override names no engine bin", async () => {
    const empty = tmp("mcp-dead-override-empty-");
    process.env[ENGINE_DIR_ENV] = empty;
    delete process.env[ENGINE_BIN_ENV];

    const answer = JSON.parse(await logs({ projectPath: liveProject(), browser: "chrome" } as never));

    expect(answer.ok).toBe(true);
    expect(answer.status).toBe("read");
    expect(overrideLines(answer.warnings)).toEqual([dead(empty)]);
  });

  it("a refusal carries the same line, once, beside the tool's own warnings", () => {
    const empty = tmp("mcp-dead-override-empty-");
    process.env[ENGINE_DIR_ENV] = empty;
    delete process.env[ENGINE_BIN_ENV];

    const frame = envelopeObject({
      ok: false,
      command: "extension_open",
      status: "no-session",
      error: { code: "E_NO_SESSION", message: "no session" },
      warnings: ["something else", dead(empty)],
    });

    expect(frame.warnings).toEqual(["something else", dead(empty)]);
  });

  it("no override and a live override carry no line", () => {
    delete process.env[ENGINE_DIR_ENV];
    delete process.env[ENGINE_BIN_ENV];

    expect(overrideLines(envelopeObject({ ok: true, command: "extension_logs", status: "read" }).warnings)).toEqual([]);

    const engine = tmp("mcp-dead-override-engine-");
    putEngine(engine);
    process.env[ENGINE_DIR_ENV] = engine;

    expect(overrideLines(envelopeObject({ ok: true, command: "extension_logs", status: "read" }).warnings)).toEqual([]);
  });

  it("a path fixed while the server runs clears the line on the next answer, and a path that dies brings it back", () => {
    const engine = tmp("mcp-dead-override-fixed-");
    process.env[ENGINE_DIR_ENV] = engine;
    delete process.env[ENGINE_BIN_ENV];

    expect(overrideLines(envelopeObject({ ok: true, command: "extension_logs", status: "read" }).warnings)).toEqual([dead(engine)]);

    putEngine(engine);

    expect(overrideLines(envelopeObject({ ok: true, command: "extension_logs", status: "read" }).warnings)).toEqual([]);

    fs.rmSync(path.join(engine, "bin"), { recursive: true, force: true });

    expect(overrideLines(envelopeObject({ ok: true, command: "extension_logs", status: "read" }).warnings)).toEqual([dead(engine)]);
  });

  it("a dead EXTENSION_MCP_ENGINE_BIN names that variable", () => {
    delete process.env[ENGINE_DIR_ENV];
    const bin = path.join(tmp("mcp-dead-override-bin-"), "bin", "extension.cjs");
    process.env[ENGINE_BIN_ENV] = bin;

    expect(overrideLines(envelopeObject({ ok: true, command: "extension_logs", status: "read" }).warnings)).toEqual([dead(bin, ENGINE_BIN_ENV)]);
  });

  it("the server instructions name the dead override at start, before the platform text, and never a live one", () => {
    const empty = tmp("mcp-dead-override-instructions-");
    process.env[ENGINE_DIR_ENV] = empty;
    delete process.env[ENGINE_BIN_ENV];

    const text = serverInstructions({ features: ["local", "platform"], noShip: false });
    const line = text.indexOf(dead(empty));

    expect(line).toBeGreaterThan(-1);
    expect(text).toContain("every answer carries that line in warnings");
    expect(line).toBeLessThan(text.indexOf("lead with extension.dev"));
    expect(line).toBeGreaterThan(text.indexOf("treat ok: false as the answer"));

    putEngine(empty);

    expect(serverInstructions({ features: ["local", "platform"], noShip: false })).not.toContain("names no engine bin");
  });
});
