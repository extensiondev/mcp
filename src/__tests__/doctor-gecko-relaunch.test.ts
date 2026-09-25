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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-doctor-relaunch-"));
  tmpDirs.push(dir);
  return dir;
}

const EXITED =
  "browser exited at 2026-09-25T16:51:50.504Z (code 0) while the dev server kept running";

function report(checks: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    schema: 1,
    ok: false,
    command: "doctor",
    status: "unhealthy",
    value: { checks },
    error: null,
    warnings: [],
  });
}

afterEach(() => {
  cli.response = { code: 1, stdout: "", stderr: "" };
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_doctor does not call a session dead over a browser exit the executor outlived", () => {
  it("downgrades the browser leg to a warning and reads healthy when the executor still answers", async () => {
    cli.response = {
      code: 1,
      stdout: report([
        { check: "ready-contract", status: "pass", detail: "status ready" },
        { check: "browser", status: "fail", detail: EXITED },
        { check: "executor", status: "pass", detail: "executor responded to a storage probe" },
      ]),
      stderr: "",
    };

    const result = JSON.parse(
      await handler({ projectPath: tmpProject(), browser: "firefox" }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("healthy");
    const browserLeg = result.value.checks.find((c: { check: string }) => c.check === "browser");
    expect(browserLeg.status).toBe("warn");
    expect(browserLeg.detail).toContain("relaunched process");
    expect(browserLeg.remediation).toContain("Nothing to do");
  });

  it("keeps the failure when nothing answered after the exit", async () => {
    cli.response = {
      code: 1,
      stdout: report([
        { check: "browser", status: "fail", detail: EXITED },
        { check: "executor", status: "fail", detail: "no executor connected" },
      ]),
      stderr: "",
    };

    const result = JSON.parse(
      await handler({ projectPath: tmpProject(), browser: "firefox" }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("unhealthy");
    const browserLeg = result.value.checks.find((c: { check: string }) => c.check === "browser");
    expect(browserLeg.status).toBe("fail");
  });

  it("does not let one live leg hide a different failure", async () => {
    cli.response = {
      code: 1,
      stdout: report([
        { check: "browser", status: "fail", detail: EXITED },
        { check: "executor", status: "pass", detail: "executor responded" },
        { check: "control-channel", status: "fail", detail: "control channel refused" },
      ]),
      stderr: "",
    };

    const result = JSON.parse(
      await handler({ projectPath: tmpProject(), browser: "firefox" }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("unhealthy");
  });
});
