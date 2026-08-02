import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const cli = vi.hoisted(() => ({
  calls: [] as string[][],
  response: { code: 0, stdout: "[]", stderr: "" },
}));

vi.mock("../lib/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/exec")>()),
  runExtensionCli: async (args: string[]) => {
    cli.calls.push(args);
    return cli.response;
  },
  pinnedCliVersion: () => "",
}));

vi.mock("../lib/engine-version", () => ({
  refusedTheOutputFlag: () => false,
  outputFlagRefusalMessage: async () => "unused",
}));

vi.mock("../lib/process-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/process-manager")>()),
  listSessions: () => [],
  listSessionMarkers: () => [],
}));

import { handler } from "../tools/doctor";
import { readyContractPath } from "../lib/session-paths";

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-doctor-label-"));
  tmpDirs.push(dir);
  return dir;
}

function writeContract(dir: string, browser: string, contract: unknown): void {
  const ready = readyContractPath(dir, browser);
  fs.mkdirSync(path.dirname(ready), { recursive: true });
  fs.writeFileSync(ready, JSON.stringify(contract));
}

function lastBrowserFlagValue(): string | undefined {
  const argv = cli.calls[cli.calls.length - 1];
  if (!argv) return undefined;
  const at = argv.indexOf("--browser");
  return at === -1 ? undefined : argv[at + 1];
}

afterEach(() => {
  cli.calls.length = 0;
  cli.response = { code: 0, stdout: "[]", stderr: "" };
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_doctor labels the session that exists", () => {
  it("diagnoses the errored session's browser instead of a hardcoded default", async () => {
    const dir = tmpProject();
    writeContract(dir, "edge", { status: "error", errors: ["build exploded"] });
    cli.response = {
      code: 0,
      stdout: JSON.stringify([
        { check: "node", status: "pass", detail: "ok" },
      ]),
      stderr: "",
    };

    const out = JSON.parse(await handler({ projectPath: dir }));

    expect(lastBrowserFlagValue()).toBe("edge");
    expect(out.value.browser).toBe("edge");
    expect(out.ok).toBe(false);
    const runtime = out.value.checks.find(
      (c: { check: string }) => c.check === "runtime-errors",
    );
    expect(runtime.detail).toContain("build exploded");
  });

  it("keeps the errored session's browser on the E_CLI envelope too", async () => {
    const dir = tmpProject();
    writeContract(dir, "edge", { status: "error", errors: ["boom"] });
    cli.response = { code: 1, stdout: "doctor (edge), 0/7 checks passed", stderr: "" };

    const out = JSON.parse(await handler({ projectPath: dir }));

    expect(lastBrowserFlagValue()).toBe("edge");
    expect(out.value.browser).toBe("edge");
    expect(out.value.cliReport).toContain("doctor (edge)");
  });

  it("lets an explicit browser win over the error contract", async () => {
    const dir = tmpProject();
    writeContract(dir, "edge", { status: "error", errors: ["boom"] });

    const out = JSON.parse(await handler({ projectPath: dir, browser: "chrome" }));

    expect(lastBrowserFlagValue()).toBe("chrome");
    expect(out.value.browser).toBe("chrome");
  });

  it("lets a live ready contract outrank another session's error contract", async () => {
    const dir = tmpProject();
    writeContract(dir, "edge", { status: "error", errors: ["boom"] });
    writeContract(dir, "chrome", { status: "ready" });

    const out = JSON.parse(await handler({ projectPath: dir }));

    expect(lastBrowserFlagValue()).toBe("chrome");
    expect(out.value.browser).toBe("chrome");
  });
});
