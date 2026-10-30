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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withCallWaits } from "../lib/call-waits";
import { resolveCdpPort } from "../lib/cdp-port";
import { envelope } from "../lib/envelope";
import { registerSession, removeSession } from "../lib/process-manager";
import { LANDING_BUDGET_MS, landingRun } from "../lib/start-landing";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";
import { actFrame, readyContract, tabRows } from "./fixtures/engine-answers";

import type * as ActModule from "../lib/act";

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) =>
      cli.includes("--list-tabs")
        ? JSON.stringify(actFrame("inspect", tabRows([{ id: 9, url: "https://example.com/", title: "Landed" }])))
        : envelope({ ok: true, command: "extension_open", status: "ok", value: { tabId: 9, created: true } }),
  };
});

let cdpTargets: Array<{ id: string; type: string; url: string }> = [];
let attachedId = "";

vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdpTargets;
    }

    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }

    async connect() {}

    async attachToTarget(id: string) {
      attachedId = id;

      return "session-1";
    }

    async enableDomains() {}

    async navigate(_session: string, url: string) {
      cdpTargets = cdpTargets.map((target) => (target.id === attachedId ? { ...target, url } : target));
    }

    async evaluate() {
      return null;
    }

    async sendCommand(method: string, params?: Record<string, unknown>) {
      if (method === "Target.createTarget") {
        cdpTargets = [...cdpTargets, { id: "created", type: "page", url: String(params?.url ?? "") }];

        return { targetId: "created" };
      }

      return {};
    }

    disconnect() {}
  }

  return { CDPClient };
});

const open = await import("../tools/open");

const PORT = 9222;
const dirs: string[] = [];
const previousSessionDir = process.env.EXTENSION_MCP_SESSION_DIR;
let sessionDir = "";

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-landing-wait-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "F" }));

  return dir;
}

function stamp(project: string, command: "dev" | "start", overrides: Record<string, unknown>): string {
  const dir = path.join(project, "dist", "extension-js", "chrome");
  const file = path.join(dir, "ready.json");
  const now = new Date().toISOString();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      readyContract(command, "chrome", {
        status: "starting",
        pid: process.pid,
        controlPort: null,
        cdpPort: undefined,
        browserPid: undefined,
        startedAt: now,
        ts: now,
        toolchainVersion: "4.1.36",
        distPath: path.join(project, "dist", "chrome"),
        ...overrides,
      }),
    ),
  );

  return file;
}

function landLater(project: string, afterMs: number): void {
  setTimeout(() => stamp(project, "start", { status: "ready", cdpPort: PORT, browserPid: process.pid }), afterMs);
}

async function deadPid(): Promise<number> {
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise((resolve) => dead.on("exit", resolve));

  return dead.pid as number;
}

const agoIso = (ms: number): string => new Date(Date.now() - ms).toISOString();

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-landing-sessions-"));
  process.env.EXTENSION_MCP_SESSION_DIR = sessionDir;
  cdpTargets = [{ id: "blank", type: "page", url: "about:blank" }];
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    removeSession(dir, "chrome");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  fs.rmSync(sessionDir, { recursive: true, force: true });
  if (previousSessionDir === undefined) delete process.env.EXTENSION_MCP_SESSION_DIR;
  else process.env.EXTENSION_MCP_SESSION_DIR = previousSessionDir;
});

describe("landingRun reads whether a start or dev run is still landing", () => {
  it("answers nothing for a project with no receipt and no registered run", () => {
    expect(landingRun(tmpProject(), "chrome")).toBeNull();
  });

  it("answers the run with its deadline while the start receipt reads starting under a live engine", () => {
    const project = tmpProject();
    const since = Date.now() - 3_000;
    stamp(project, "start", { startedAt: new Date(since).toISOString(), ts: new Date(since).toISOString() });

    const run = landingRun(project, "chrome");

    expect(run).toMatchObject({ verb: "start", since, deadline: since + LANDING_BUDGET_MS });
    expect(run?.seen).toBe("read status starting when the call arrived");
  });

  it("answers nothing when the engine that wrote the starting receipt is dead", async () => {
    const project = tmpProject();
    stamp(project, "start", { pid: await deadPid() });

    expect(landingRun(project, "chrome")).toBeNull();
  });

  it("answers nothing once the start deadline has passed", () => {
    const project = tmpProject();
    stamp(project, "start", { startedAt: agoIso(LANDING_BUDGET_MS + 1_000), ts: agoIso(LANDING_BUDGET_MS + 1_000) });

    expect(landingRun(project, "chrome")).toBeNull();
  });

  it("waits on a ready receipt without a port only when the engine will ever stamp one", () => {
    const project = tmpProject();
    stamp(project, "start", { status: "ready", browserPid: process.pid, toolchainVersion: "4.1.32" });
    expect(landingRun(project, "chrome")).toBeNull();

    stamp(project, "start", { status: "ready", browserPid: process.pid, toolchainVersion: "4.1.36" });
    expect(landingRun(project, "chrome")?.seen).toBe("read status ready when the call arrived");
  });

  it("treats a dev contract as landing only while it reads starting", () => {
    const project = tmpProject();
    stamp(project, "dev", {});
    expect(landingRun(project, "chrome")?.verb).toBe("dev");

    stamp(project, "dev", { status: "ready" });
    expect(landingRun(project, "chrome")).toBeNull();
  });

  it("treats a registered live run whose receipt is not written yet, or still describes the run it replaces, as landing", async () => {
    const project = tmpProject();
    registerSession({ pid: process.pid, browser: "chrome", projectPath: project, command: "start", allowControl: true });

    expect(landingRun(project, "chrome")?.seen).toBe("had not been written yet when the call arrived");

    stamp(project, "start", { status: "ready", pid: await deadPid(), browserPid: process.pid });
    expect(landingRun(project, "chrome")?.seen).toBe("still described the run being replaced when the call arrived");
  });
});

describe("resolveCdpPort waits for a landing run within the verb's own timeout", () => {
  it("answers the port once it lands, and the call's answer says it waited", async () => {
    const project = tmpProject();
    stamp(project, "start", {});
    landLater(project, 700);

    const started = Date.now();
    const answer = JSON.parse(
      await withCallWaits(async () => {
        const resolved = await resolveCdpPort(project, "chrome", { timeoutMs: 15_000 });

        return envelope({ ok: true, command: "probe", status: "ok", value: { port: resolved?.port ?? null } });
      }),
    );

    expect(answer.value.port).toBe(PORT);
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(answer.warnings).toHaveLength(1);
    expect(answer.warnings[0]).toMatch(
      /^This call waited \d+\.\d s for the chrome extension_start run to land \(its ready\.json read status starting when the call arrived\) before answering\.$/,
    );
  });

  it("refuses at once when there is no run at all, whatever the verb's timeout", async () => {
    const started = Date.now();

    expect(await resolveCdpPort(tmpProject(), "chrome", { timeoutMs: 20_000 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("refuses at once when the engine behind the starting receipt is dead", async () => {
    const project = tmpProject();
    stamp(project, "start", { pid: await deadPid() });
    const started = Date.now();

    expect(await resolveCdpPort(project, "chrome", { timeoutMs: 20_000, graceMs: 100 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("refuses without the landing wait once the start deadline has passed", async () => {
    const project = tmpProject();
    stamp(project, "start", { startedAt: agoIso(LANDING_BUDGET_MS + 1_000), ts: agoIso(LANDING_BUDGET_MS + 1_000) });
    const started = Date.now();

    expect(await resolveCdpPort(project, "chrome", { timeoutMs: 20_000, graceMs: 100 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("bounds the landing wait by the verb's timeout, never by the run's deadline", async () => {
    const project = tmpProject();
    stamp(project, "start", {});
    const started = Date.now();

    expect(await resolveCdpPort(project, "chrome", { timeoutMs: 1_000 })).toBeNull();

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2_500);
  }, 4_000);

  it("never waits for a caller that asked for no wait at all", async () => {
    const project = tmpProject();
    stamp(project, "start", {});
    const started = Date.now();

    expect(await resolveCdpPort(project, "chrome", { waitMs: 0 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(400);
  });
});

describe("a debug-port verb sent during a landing extension_start run answers normally", () => {
  it("extension_open {url} opens the page once the port lands and carries the waited line in its warnings", async () => {
    const project = tmpProject();
    stamp(project, "start", {});
    landLater(project, 700);
    const dispatch = createToolDispatcher({ tools: [open as ToolModule], options: { features: ["local"], noShip: false } });

    const frame = await dispatch({ name: "extension_open", arguments: { projectPath: project, url: "https://example.com/" } });
    const out = JSON.parse(frame.content[0]?.text ?? "{}");

    expect(out.status).not.toBe("no-session");
    expect(out.ok).toBe(true);
    expect(cdpTargets.some((target) => target.url === "https://example.com/")).toBe(true);
    expect(out.warnings.filter((line: string) => /^This call waited .* for the chrome extension_start run to land/.test(line))).toHaveLength(1);
  }, 15_000);
});
