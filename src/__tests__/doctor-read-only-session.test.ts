import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const cli = vi.hoisted(() => ({
  response: { code: 1, stdout: "", stderr: "" },
}));

vi.mock("../lib/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/exec")>()),
  runExtensionCli: async () => cli.response,
  pinnedCliVersion: () => "",
}));

vi.mock("../lib/engine-version", () => ({
  refusedTheOutputFlag: () => false,
  outputFlagRefusalMessage: async () => "unused",
}));

import { handler } from "../tools/doctor";

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-doctor-readonly-"));
  tmpDirs.push(dir);
  return dir;
}

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

function healthyLegs(): Check[] {
  return [
    {
      check: "ready-contract",
      status: "pass",
      detail: "status ready, controlPort 59999, instanceId abc",
    },
    { check: "server-process", status: "pass", detail: "dev-server pid 1 is alive" },
    {
      check: "port-agreement",
      status: "pass",
      detail: "no persisted control-port file",
    },
  ];
}

function skippedLegs(): Check[] {
  return [
    { check: "eval-token", status: "skip", detail: "skipped: blocked by control-channel" },
    { check: "executor", status: "skip", detail: "skipped: blocked by control-channel" },
    { check: "browser", status: "pass", detail: "browser alive on cdpPort 9222" },
  ];
}

const controlOffByChoice: Check = {
  check: "control-channel",
  status: "fail",
  detail: "refused: session was not started with --allow-control",
  remediation:
    "Restart with control enabled: extension dev --browser=chrome --allow-control",
};

const controlRefusedAmbiguously: Check = {
  check: "control-channel",
  status: "fail",
  detail:
    "control channel refused the controller (code 1006). Is the session started with --allow-control?",
  remediation:
    "The control server did not answer on the contract port, the session may have died or the port was taken; restart the dev session",
};

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

describe("extension_doctor reads the shipped engine's own envelope", () => {
  it("finds the check list when the engine puts it in value directly", async () => {
    cli.response = {
      code: 1,
      stdout: engineEnvelope([...healthyLegs(), controlRefusedAmbiguously, ...skippedLegs()]),
      stderr: "",
    };

    const out = JSON.parse(await handler({ projectPath: tmpProject(), browser: "chrome" }));

    expect(out.error?.code).not.toBe("E_CLI");
    expect(out.status).toBe("unhealthy");
    expect(Array.isArray(out.value.checks)).toBe(true);
    expect(out.value.checks.map((c: Check) => c.check)).toContain("control-channel");
    expect(out.value.cliReport).toBeUndefined();
  });
});

describe("extension_doctor on a session that is read-only by choice", () => {
  it("does not call a deliberately uncontrolled session an error", async () => {
    cli.response = {
      code: 1,
      stdout: engineEnvelope([...healthyLegs(), controlOffByChoice, ...skippedLegs()]),
      stderr: "",
    };

    const out = JSON.parse(await handler({ projectPath: tmpProject(), browser: "chrome" }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("read-only");
    expect(out.error).toBeNull();
    expect(out.value.readOnly).toBe(true);
  });

  it("names the condition on the leg instead of leaving it a failure", async () => {
    cli.response = {
      code: 1,
      stdout: engineEnvelope([...healthyLegs(), controlOffByChoice, ...skippedLegs()]),
      stderr: "",
    };

    const out = JSON.parse(await handler({ projectPath: tmpProject(), browser: "chrome" }));

    const leg = out.value.checks.find((c: Check) => c.check === "control-channel");
    expect(leg.status).toBe("warn");
    expect(leg.detail).toMatch(/read-only by choice/);
    expect(leg.remediation).toMatch(/replace: true/);
    expect(out.value.checks.some((c: Check) => c.status === "fail")).toBe(false);
    expect(out.hint).toMatch(/allowControl/);
  });

  it("still refuses when a real failure sits beside the missing control channel", async () => {
    cli.response = {
      code: 1,
      stdout: engineEnvelope([
        ...healthyLegs(),
        controlOffByChoice,
        { check: "eval-token", status: "skip", detail: "skipped: blocked by control-channel" },
        { check: "executor", status: "skip", detail: "skipped: blocked by control-channel" },
        {
          check: "browser",
          status: "fail",
          detail: "browser exited with code 1",
          remediation: "restart the dev session",
        },
      ]),
      stderr: "",
    };

    const out = JSON.parse(await handler({ projectPath: tmpProject(), browser: "chrome" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("unhealthy");
    expect(out.value.readOnly).toBeUndefined();
  });

  it("does not read an ambiguous 1006 refusal as a deliberate choice", async () => {
    cli.response = {
      code: 1,
      stdout: engineEnvelope([
        ...healthyLegs(),
        controlRefusedAmbiguously,
        ...skippedLegs(),
      ]),
      stderr: "",
    };

    const out = JSON.parse(await handler({ projectPath: tmpProject(), browser: "chrome" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("unhealthy");
    expect(out.value.readOnly).toBeUndefined();
  });

  it("keeps a bare check array working, envelope or not", async () => {
    cli.response = {
      code: 1,
      stdout: JSON.stringify([...healthyLegs(), controlOffByChoice, ...skippedLegs()]),
      stderr: "",
    };

    const out = JSON.parse(await handler({ projectPath: tmpProject(), browser: "chrome" }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("read-only");
  });
});
