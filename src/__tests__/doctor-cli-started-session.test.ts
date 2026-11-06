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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "../tools/doctor";
import { readyContractPath } from "../lib/session-paths";

import type * as ExecModule from "../lib/exec";
import type * as ProcessManagerModule from "../lib/process-manager";
import type { ProcessInfo } from "../lib/types";

const cli = vi.hoisted(() => ({
  response: { code: 1, stdout: "", stderr: "" },
}));

const registry = vi.hoisted(() => ({
  sessions: [] as ProcessInfo[],
  markers: [] as ProcessInfo[],
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

vi.mock("../lib/process-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessManagerModule>()),
  listSessions: () => registry.sessions,
  listSessionMarkers: () => registry.markers,
}));

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-doctor-cli-session-"));
  tmpDirs.push(dir);

  return dir;
}

function writeReadyContract(dir: string, browser: string): void {
  const ready = readyContractPath(dir, browser);
  fs.mkdirSync(path.dirname(ready), { recursive: true });
  fs.writeFileSync(
    ready,
    JSON.stringify({
      status: "ready",
      pid: process.pid,
      browser,
      controlPort: 59999,
      instanceId: "abc",
    }),
  );
}

beforeEach(() => {
  registry.sessions = [];
  registry.markers = [];
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type Check = {
  check: string;
  status: string;
  detail: string;
  remediation?: string;
};

function controlOffChecks(): Check[] {
  return [
    {
      check: "ready-contract",
      status: "pass",
      detail: "status ready, controlPort 59999, instanceId abc",
    },
    { check: "server-process", status: "pass", detail: "dev-server pid 1 is alive" },
    { check: "port-agreement", status: "pass", detail: "no persisted control-port file" },
    {
      check: "control-channel",
      status: "fail",
      detail: "refused: control is off in the session that answered",
      remediation:
        "Restart with control enabled: extension dev --browser=chromium --allow-control",
    },
    { check: "eval-token", status: "skip", detail: "skipped: blocked by control-channel" },
    { check: "executor", status: "skip", detail: "skipped: blocked by control-channel" },
    { check: "browser", status: "pass", detail: "browser alive on cdpPort 9222" },
  ];
}

function engineEnvelope(checks: Check[]): string {
  return JSON.stringify({
    schema: 1,
    ok: false,
    command: "doctor",
    status: "unhealthy",
    value: checks,
    error: { code: "E_CONTROL_UNAVAILABLE", message: "1 of 7 doctor checks failed." },
    warnings: [],
    hint: "restart the dev session",
  });
}

async function doctor(projectPath: string) {
  cli.response = { code: 1, stdout: engineEnvelope(controlOffChecks()), stderr: "" };

  return JSON.parse(await handler({ projectPath, browser: "chromium" }));
}

function controlLeg(out: { value: { checks: Check[] } }): Check {
  const leg = out.value.checks.find((c) => c.check === "control-channel");
  if (!leg) throw new Error("no control-channel leg");

  return leg;
}

describe("extension_doctor on a read-only session the CLI started", () => {
  it("names the CLI flag, not allowControl: false, when the session comes from the ready contract", async () => {
    const dir = tmpProject();
    writeReadyContract(dir, "chromium");

    const out = await doctor(dir);

    expect(out.ok).toBe(true);
    expect(out.status).toBe("read-only");
    expect(out.value.startedBy).toBe("cli");
    expect(out.hint).toMatch(/--allow-control/);
    expect(out.hint).not.toMatch(/allowControl: false/);
    expect(controlLeg(out).status).toBe("warn");
    expect(controlLeg(out).remediation).not.toMatch(/allowControl: false/);
  });

  it("leads with the rerun that keeps the person's window and puts replace: true last", async () => {
    const dir = tmpProject();
    writeReadyContract(dir, "chromium");

    const out = await doctor(dir);

    const remediation = String(controlLeg(out).remediation);

    expect(remediation).toMatch(/npx extension dev --browser chromium --allow-control/);
    expect(remediation).toMatch(/--allow-eval/);
    expect(remediation.indexOf("--allow-control")).toBeLessThan(
      remediation.indexOf("replace: true"),
    );

    expect(remediation).toMatch(/stops the browser the person is using/);
  });

  it("reads a session known only by its marker as CLI-started too", async () => {
    const dir = tmpProject();
    registry.markers = [
      { pid: process.pid, browser: "chromium", projectPath: dir, command: "dev" },
    ];

    const out = await doctor(dir);

    expect(out.value.startedBy).toBe("cli");
    expect(out.hint).toMatch(/the CLI started it without --allow-control/);
  });

  it("keeps the allowControl: false wording for a session extension_dev started", async () => {
    const dir = tmpProject();
    writeReadyContract(dir, "chromium");
    registry.sessions = [
      {
        pid: process.pid,
        browser: "chromium",
        projectPath: dir,
        command: "dev",
        allowControl: false,
      },
    ];

    const out = await doctor(dir);

    expect(out.ok).toBe(true);
    expect(out.status).toBe("read-only");
    expect(out.value.startedBy).toBe("extension_dev");
    expect(out.hint).toMatch(/started with allowControl: false/);
    expect(controlLeg(out).remediation).toMatch(/without allowControl: false/);
    expect(controlLeg(out).remediation).toMatch(/replace: true/);
    expect(controlLeg(out).remediation).not.toMatch(/npx extension dev/);
  });
});
