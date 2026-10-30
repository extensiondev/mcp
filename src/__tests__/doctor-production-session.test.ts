import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "../tools/doctor";
import { readyContract } from "./fixtures/engine-answers";

import type * as ExecModule from "../lib/exec";

const cli = vi.hoisted(() => ({
  response: { code: 1, stdout: "", stderr: "" },
}));

const bridge = vi.hoisted(() => ({
  connectError: null as string | null,
  capabilities: { storage: true, reload: true, eval: false } as Record<string, unknown>,
  probe: { ok: true, value: {} } as { ok: boolean; value?: unknown; error?: { name: string; message: string } },
  token: null as string | null,
  closed: 0,
  constructed: [] as Array<{ controlPort: number; instanceId: string; token?: string }>,
}));

const cdp = vi.hoisted(() => ({
  version: "Chrome/151.0.7922.71" as string | null,
  throws: null as string | null,
}));

vi.mock("../lib/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof ExecModule>()),
  runExtensionCli: async () => cli.response,
  pinnedCliVersion: () => "",
}));

vi.mock("../lib/engine-version", () => ({
  refusedTheOutputFlag: () => false,
  outputFlagRefusalMessage: async () => "unused",
}));

vi.mock("../lib/session-capabilities", () => ({
  readSessionCapabilities: async () => ({ capabilities: null, reason: "not read in this suite" }),
}));

vi.mock("../lib/cdp", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeCdp {
    static async discoverBrowserVersion() {
      if (cdp.throws) throw new Error(cdp.throws);

      return cdp.version;
    }
  }

  return { ...actual, CDPClient: FakeCdp };
});

vi.mock("extension-develop/bridge", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeController {
    constructor(options: { controlPort: number; instanceId: string; token?: string }) {
      bridge.constructed.push(options);
    }
    async connect() {
      if (bridge.connectError) throw new Error(bridge.connectError);

      return { type: "ready", runId: "run", capabilities: bridge.capabilities };
    }
    async command() {
      return { type: "result", cmdId: "1", ...bridge.probe };
    }
    close() {
      bridge.closed += 1;
    }
  }

  return { ...actual, BridgeController: FakeController, readControlToken: () => bridge.token };
});

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-doctor-production-"));
  tmpDirs.push(dir);

  return dir;
}

function writeContract(projectPath: string, browser: string, contract: Record<string, unknown>): string {
  const dir = path.join(projectPath, "dist", "extension-js", browser);
  const file = path.join(dir, "ready.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(readyContract("start", browser, contract)));

  return file;
}

function controlledReceipt(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: "start",
    status: "ready",
    pid: process.pid,
    instanceId: "0453d951-7ca6-486f-a560-8e3af3617d12",
    controlPort: 56181,
    cdpPort: 9222,
    browserPid: process.pid,
    executorAttachedAt: new Date().toISOString(),
    runtime: "attached",
    ts: new Date().toISOString(),
    compiledAt: new Date().toISOString(),
    ...extra,
  };
}

type Check = { check: string; status: string; detail: string; remediation?: string };

function engineRefusal(readyPath: string, verb = "start"): string {
  const checks: Check[] = [
    { check: "peer-rspack", status: "pass", detail: "every direct dependency accepts the engine's rspack" },
    {
      check: "ready-contract",
      status: "fail",
      detail: `no dev session for chrome: ${readyPath} is the receipt of an extension ${verb} run, not a session contract`,
      remediation: "Start a dev session first: extension dev --browser=chrome --allow-control (add --allow-eval for the eval verb)",
    },
    ...["server-process", "port-agreement", "control-channel", "eval-token", "executor", "browser"].map((check) => ({
      check,
      status: "skip",
      detail: "skipped: blocked by ready-contract",
    })),
  ];

  return JSON.stringify({ schema: 1, ok: false, command: "doctor", status: "unhealthy", value: checks, error: { code: "E_NO_SESSION", message: "1 of 8 doctor checks failed." }, warnings: [] });
}

function legs(out: { value: { checks: Check[] } }): Record<string, Check> {
  return Object.fromEntries(out.value.checks.map((leg) => [leg.check, leg]));
}

beforeEach(() => {
  bridge.connectError = null;
  bridge.capabilities = { storage: true, reload: true, eval: false };
  bridge.probe = { ok: true, value: {} };
  bridge.token = null;
  bridge.closed = 0;
  bridge.constructed = [];
  cdp.version = "Chrome/151.0.7922.71";
  cdp.throws = null;
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_doctor on a production session with the control channel", () => {
  it("checks the legs the receipt carries and answers healthy instead of asking for a dev session", async () => {
    const project = tmpProject();
    const readyPath = writeContract(project, "chrome", controlledReceipt());
    cli.response = { code: 1, stdout: engineRefusal(readyPath), stderr: "" };

    const out = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));
    const leg = legs(out);

    expect(out.ok).toBe(true);
    expect(out.status).toBe("healthy");
    expect(out.value.sessionCommand).toBe("start");
    expect(out.value.checks.map((c: Check) => c.check)).toEqual([
      "peer-rspack",
      "ready-contract",
      "server-process",
      "port-agreement",
      "control-channel",
      "eval-token",
      "executor",
      "browser",
      "debug-port",
    ]);

    expect(leg["ready-contract"].status).toBe("pass");
    expect(leg["ready-contract"].detail).toMatch(/production session \(extension_start/);
    expect(leg["ready-contract"].detail).toContain("controlPort 56181");
    expect(leg["ready-contract"].detail).toContain("instanceId 0453d951-7ca6-486f-a560-8e3af3617d12");
    expect(leg["server-process"]).toMatchObject({ status: "pass", detail: `engine process pid ${process.pid} (extension start) is alive` });
    expect(leg["port-agreement"].status).toBe("skip");
    expect(leg["port-agreement"].detail).toMatch(/persists none/);
    expect(leg["control-channel"]).toMatchObject({ status: "pass" });
    expect(leg["control-channel"].detail).toContain('"storage":true');
    expect(leg["eval-token"]).toMatchObject({ status: "pass", detail: "eval disabled (allowEval not set), nothing to verify" });
    expect(leg.executor).toMatchObject({ status: "pass", detail: "executor responded to a storage probe" });
    expect(leg.browser).toMatchObject({ status: "pass", detail: `browser pid ${process.pid} is alive` });
    expect(leg["debug-port"]).toMatchObject({ status: "pass", detail: "debug port 9222 answers (Chrome/151.0.7922.71)" });
    expect(out.value.checks.some((c: Check) => /blocked by ready-contract/.test(c.detail))).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/not a session contract|Start a dev session/);
    expect(out.hint).toMatch(/production session \(extension_start with allowControl\)/);
    expect(bridge.constructed).toEqual([{ controlPort: 56181, instanceId: "0453d951-7ca6-486f-a560-8e3af3617d12", token: undefined, connectTimeoutMs: 5000 }]);
    expect(bridge.closed).toBe(1);
  });

  it("keeps the engine's project legs around the production legs", async () => {
    const project = tmpProject();
    const readyPath = writeContract(project, "chrome", controlledReceipt());
    cli.response = { code: 1, stdout: engineRefusal(readyPath), stderr: "" };

    const out = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));

    expect(out.value.checks[0]).toMatchObject({ check: "peer-rspack", status: "pass" });
    expect(out.value.checks.filter((c: Check) => c.check === "ready-contract")).toHaveLength(1);
  });

  it("fails the control channel the way the engine does when the instanceId no longer matches", async () => {
    const project = tmpProject();
    const readyPath = writeContract(project, "chrome", controlledReceipt());
    cli.response = { code: 1, stdout: engineRefusal(readyPath), stderr: "" };
    bridge.connectError = "control channel closed with code 4001";

    const out = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));
    const leg = legs(out);

    expect(out.status).toBe("unhealthy");
    expect(leg["control-channel"]).toMatchObject({ status: "fail", detail: "refused: ready.json instanceId no longer matches the live control server" });
    expect(leg["control-channel"].remediation).toMatch(/extension_start again/);
    expect(leg["control-channel"].remediation).not.toMatch(/extension_dev/);
    expect(leg["eval-token"]).toMatchObject({ status: "skip", detail: "skipped: blocked by control-channel" });
    expect(leg.executor).toMatchObject({ status: "skip", detail: "skipped: blocked by control-channel" });
    expect(leg.browser.status).toBe("pass");
    expect(leg["debug-port"].status).toBe("pass");
  });

  it("warns, not fails, when the background has not attached within the launch grace", async () => {
    const project = tmpProject();
    const readyPath = writeContract(project, "chrome", controlledReceipt({ executorAttachedAt: undefined, runtime: undefined }));
    cli.response = { code: 1, stdout: engineRefusal(readyPath), stderr: "" };
    bridge.probe = { ok: false, error: { name: "Unavailable", message: "no executor connected" } };

    const out = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));
    const leg = legs(out);

    expect(out.status).toBe("healthy");
    expect(leg.executor.status).toBe("warn");
    expect(leg.executor.detail).toMatch(/still launching/);
    expect(leg.executor.remediation).toMatch(/extension_wait/);
  });

  it("fails the executor once the launch grace is over and the background never attached", async () => {
    const project = tmpProject();
    const stale = new Date(Date.now() - 60_000).toISOString();
    const readyPath = writeContract(project, "chrome", controlledReceipt({ executorAttachedAt: undefined, runtime: undefined, ts: stale, compiledAt: stale, startedAt: stale }));
    cli.response = { code: 1, stdout: engineRefusal(readyPath), stderr: "" };
    bridge.probe = { ok: false, error: { name: "Unavailable", message: "no executor connected" } };

    const out = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));

    expect(out.status).toBe("unhealthy");
    expect(legs(out).executor).toMatchObject({ status: "fail", detail: "no executor connected" });
  });

  it("reads the eval token when the run was started with allowEval", async () => {
    const project = tmpProject();
    const readyPath = writeContract(project, "chrome", controlledReceipt());
    cli.response = { code: 1, stdout: engineRefusal(readyPath), stderr: "" };
    bridge.capabilities = { storage: true, eval: true };

    const missing = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));
    expect(legs(missing)["eval-token"]).toMatchObject({ status: "fail" });
    expect(legs(missing)["eval-token"].remediation).toMatch(/extension_start again with allowEval: true/);

    bridge.token = "secret";
    const present = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));
    expect(legs(present)["eval-token"]).toMatchObject({ status: "pass", detail: "eval enabled and the session token is readable" });
    expect(bridge.constructed[bridge.constructed.length - 1]?.token).toBe("secret");
  });

  it("fails the debug-port leg when the port stopped answering", async () => {
    const project = tmpProject();
    const readyPath = writeContract(project, "chrome", controlledReceipt());
    cli.response = { code: 1, stdout: engineRefusal(readyPath), stderr: "" };
    cdp.throws = "connect ECONNREFUSED 127.0.0.1:9222";

    const out = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));

    expect(out.status).toBe("unhealthy");
    expect(legs(out)["debug-port"]).toMatchObject({ status: "fail", detail: "debug port 9222 did not answer: connect ECONNREFUSED 127.0.0.1:9222" });
  });
});

describe("extension_doctor on a production session without the control channel", () => {
  it("answers what it can and says the control verbs need allowControl: true, never a dev session", async () => {
    const project = tmpProject();
    const readyPath = writeContract(project, "chrome", controlledReceipt({ instanceId: undefined, controlPort: null, cdpPort: undefined, executorAttachedAt: undefined, runtime: undefined }));
    cli.response = { code: 1, stdout: engineRefusal(readyPath), stderr: "" };

    const out = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));
    const leg = legs(out);

    expect(out.ok).toBe(true);
    expect(out.status).toBe("healthy");
    expect(out.value.readOnly).toBeUndefined();
    expect(leg["ready-contract"].detail).toContain("no control channel (started without allowControl)");
    expect(leg["server-process"].status).toBe("pass");
    expect(leg["port-agreement"]).toMatchObject({ status: "skip", detail: "skipped: no control channel, so there is no control port to agree on" });
    expect(leg["control-channel"].status).toBe("skip");
    expect(leg["control-channel"].detail).toMatch(/extension_start with allowControl: true/);
    expect(leg["eval-token"]).toMatchObject({ status: "skip", detail: "skipped: blocked by control-channel" });
    expect(leg.executor).toMatchObject({ status: "skip", detail: "skipped: blocked by control-channel" });
    expect(leg.browser.status).toBe("pass");
    expect(leg["debug-port"]).toMatchObject({ status: "skip" });
    expect(leg["debug-port"].detail).toMatch(/names no cdpPort yet/);
    expect(out.hint).toMatch(/allowControl: true and replace: true/);
    expect(out.hint).toMatch(/not a dev session to restart/);
    expect(JSON.stringify(out)).not.toMatch(/Start a dev session|extension_dev with/);
    expect(bridge.constructed).toEqual([]);
  });
});

describe("extension_doctor on a production session that is not up", () => {
  it("names extension_wait, not extension_dev, while the receipt is still landing", async () => {
    const project = tmpProject();
    const readyPath = writeContract(project, "chrome", controlledReceipt({ status: "starting", cdpPort: undefined, browserPid: undefined, executorAttachedAt: undefined, runtime: undefined }));
    cli.response = { code: 1, stdout: engineRefusal(readyPath), stderr: "" };

    const out = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));
    const leg = legs(out);

    expect(out.status).toBe("unhealthy");
    expect(leg["ready-contract"].status).toBe("fail");
    expect(leg["ready-contract"].detail).toMatch(/status is 'starting'/);
    expect(leg["ready-contract"].remediation).toContain(`extension_wait {projectPath: ${JSON.stringify(project)}, browser: "chrome"}`);
    expect(leg["ready-contract"].remediation).toMatch(/Do not start extension_dev/);
    expect(leg["server-process"].status).toBe("pass");
    expect(leg["control-channel"]).toMatchObject({ status: "skip", detail: "skipped: blocked by ready-contract" });
    expect(leg.browser).toMatchObject({ status: "skip" });
    expect(leg.browser.detail).toMatch(/not recorded a browser launch yet/);
    expect(leg["debug-port"].status).toBe("skip");
    expect(bridge.constructed).toEqual([]);
  });

  it("fails the engine process when the run that wrote the receipt is gone", async () => {
    const project = tmpProject();
    const readyPath = writeContract(project, "chrome", controlledReceipt({ pid: 2_147_483_000 }));
    cli.response = { code: 1, stdout: engineRefusal(readyPath), stderr: "" };

    const out = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));
    const leg = legs(out);

    expect(out.status).toBe("unhealthy");
    expect(leg["server-process"]).toMatchObject({ status: "fail", detail: "engine process pid 2147483000 is gone, ready.json describes a production run that ended" });
    expect(leg["server-process"].remediation).toMatch(/extension_stop .* extension_start again/);
    expect(leg["control-channel"]).toMatchObject({ status: "skip", detail: "skipped: blocked by server-process" });
    expect(bridge.constructed).toEqual([]);
  });
});

describe("the dev path is untouched", () => {
  it("passes an engine answer on a dev contract through as before, with no production leg", async () => {
    const project = tmpProject();
    const dir = path.join(project, "dist", "extension-js", "chrome");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify(readyContract("dev", "chrome", { pid: process.pid, cdpPort: 9222 })));
    const devChecks: Check[] = [
      { check: "ready-contract", status: "pass", detail: "status ready, controlPort 43210, instanceId inst-fixture" },
      { check: "server-process", status: "pass", detail: `dev-server pid ${process.pid} is alive` },
      { check: "port-agreement", status: "pass", detail: "no persisted control-port file" },
      { check: "control-channel", status: "pass", detail: "connected, capabilities: {}" },
      { check: "eval-token", status: "pass", detail: "eval disabled" },
      { check: "executor", status: "pass", detail: "executor responded to a storage probe" },
      { check: "browser", status: "pass", detail: "browser alive on cdpPort 9222" },
    ];
    cli.response = { code: 0, stdout: JSON.stringify({ schema: 1, ok: true, command: "doctor", status: "healthy", value: devChecks, error: null, warnings: [] }), stderr: "" };

    const out = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));

    expect(out.status).toBe("healthy");
    expect(out.value.sessionCommand).toBeUndefined();
    expect(out.value.checks.map((c: Check) => c.check)).toEqual(devChecks.map((c) => c.check));
    expect(out.value.checks.map((c: Check) => c.detail)).toEqual(devChecks.map((c) => c.detail));
    expect(out.hint).toBeUndefined();
    expect(bridge.constructed).toEqual([]);
  });

  it("defers to an engine whose doctor already passes a production receipt", async () => {
    const project = tmpProject();
    writeContract(project, "chrome", controlledReceipt());
    const engineLegs: Check[] = [
      { check: "ready-contract", status: "pass", detail: "status ready, controlPort 56181, instanceId x (production)" },
      { check: "browser", status: "pass", detail: "browser alive" },
    ];
    cli.response = { code: 0, stdout: JSON.stringify({ schema: 1, ok: true, command: "doctor", status: "healthy", value: engineLegs, error: null, warnings: [] }), stderr: "" };

    const out = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));

    expect(out.value.checks.map((c: Check) => c.detail)).toEqual(engineLegs.map((c) => c.detail));
    expect(bridge.constructed).toEqual([]);
  });
});
