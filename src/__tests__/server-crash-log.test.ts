// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installCrashGuard, type CrashGuard } from "../lib/server-crash-guard";
import {
  appendServerLog,
  SERVER_LOG_CAP_BYTES,
  SERVER_LOG_KEPT_BYTES,
  serverLogPath,
  type ServerLogRecord,
} from "../lib/server-crash-log";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";
import { ENGINE_DIR_ENV } from "../lib/engine-override";
import { handler as doctor } from "../tools/doctor";

const saved = { xdg: process.env.XDG_CONFIG_HOME, engine: process.env[ENGINE_DIR_ENV] };
const dirs: string[] = [];
const guards: CrashGuard[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);

  return dir;
}

function fakeProcess(pid: number): EventEmitter & { pid: number; uptime: () => number } {
  return Object.assign(new EventEmitter(), { pid, uptime: () => 3600 });
}

function guard(pid: number) {
  const proc = fakeProcess(pid);
  const stdout = new EventEmitter();
  const stdin = new EventEmitter();
  const said: string[] = [];
  const exits: number[] = [];
  const installed = installCrashGuard({
    version: "9.9.9",
    proc,
    stdin,
    stdout,
    stderr: { write: (text: string) => said.push(text) },
    exit: (code) => exits.push(code),
  });
  guards.push(installed);

  return { proc, stdout, stdin, said, exits, installed };
}

function records(): ServerLogRecord[] {
  return fs
    .readFileSync(serverLogPath(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ServerLogRecord);
}

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = tmp("mcp-crash-log-xdg-");
});

afterEach(() => {
  for (const installed of guards.splice(0)) installed.uninstall();

  for (const [key, value] of [
    ["XDG_CONFIG_HOME", saved.xdg],
    [ENGINE_DIR_ENV, saved.engine],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the server records why it failed and keeps serving", () => {
  it("an unhandled rejection during a tool call is logged and the call answers ok:false naming the log", async () => {
    const { proc, said, exits } = guard(4242);
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hanging: ToolModule = {
      schema: { name: "extension_doctor", description: "x", inputSchema: { type: "object", properties: {} } },
      handler: () => {
        entered();

        return new Promise<string>(() => undefined);
      },
    };
    const dispatch = createToolDispatcher({ tools: [hanging], options: { features: ["local"], noShip: false } });

    const call = dispatch({ name: "extension_doctor", arguments: {} });
    await started;
    proc.emit("unhandledRejection", new Error("watcher went away"), Promise.resolve());
    const out = JSON.parse((await call).content[0]?.text ?? "{}");

    expect(out.ok).toBe(false);
    expect(out.error.message).toContain(serverLogPath());
    expect(out.value.serverLog).toBe(serverLogPath());
    expect(exits).toEqual([]);

    const crash = records().find((record) => record.kind === "crash")!;
    expect(crash).toMatchObject({ event: "unhandledRejection", pid: 4242, version: "9.9.9", uptimeSeconds: 3600, inFlight: ["extension_doctor"] });
    expect(crash.error?.message).toBe("watcher went away");
    expect(crash.error?.stack).toContain("watcher went away");
    expect(said.join("")).toContain("unhandledRejection Error: watcher went away");
  });

  it("a stdout EPIPE records the reason and resolves the shutdown with a non-zero code", async () => {
    const { stdout, exits, installed } = guard(4343);
    stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    const shutdown = await installed.shutdown;
    expect(shutdown.code).toBe(1);
    expect(shutdown.reason).toContain("EPIPE");
    expect(exits).toEqual([1]);
    expect(records().slice(-1)[0]).toMatchObject({ kind: "exit", code: 1, pid: 4343 });
  });

  it("truncates the log to its newest lines once it passes the cap", () => {
    const file = serverLogPath();
    const filler = { at: "2026-11-08T00:00:00.000Z", kind: "start", reason: "x".repeat(1000), pid: 1, version: "0", uptimeSeconds: 0 } as const;

    let written = 0;

    while (!fs.existsSync(file) || fs.statSync(file).size <= SERVER_LOG_CAP_BYTES) {
      appendServerLog(filler, file);
      written += 1;
    }

    appendServerLog({ ...filler, kind: "exit", reason: "newest" }, file);

    expect(fs.statSync(file).size).toBeLessThanOrEqual(SERVER_LOG_KEPT_BYTES + 2_000);
    expect(records().length).toBeLessThan(written / 3);
    expect(records().slice(-1)[0]?.reason).toBe("newest");
  });

  it("extension_doctor names the log and the previous server's exit reason", async () => {
    const engine = tmp("mcp-crash-log-engine-");
    fs.mkdirSync(path.join(engine, "bin"), { recursive: true });
    fs.writeFileSync(path.join(engine, "bin", "extension.cjs"), 'console.log("9.9.9");\n');
    fs.writeFileSync(path.join(engine, "package.json"), JSON.stringify({ name: "extension", version: "9.9.9" }));
    process.env[ENGINE_DIR_ENV] = engine;
    appendServerLog({ at: "2026-11-08T17:15:00.000Z", kind: "exit", reason: "received SIGTERM", code: 143, pid: 77, version: "10.22.0", uptimeSeconds: 9 });

    const out = JSON.parse(await doctor({}));

    expect(out.value.serverLog.path).toBe(serverLogPath());
    expect(out.value.serverLog.lastExit).toMatchObject({ pid: 77, reason: "received SIGTERM", code: 143, recorded: true });
    expect(out.hint).toContain("received SIGTERM");
  }, 20_000);
});
