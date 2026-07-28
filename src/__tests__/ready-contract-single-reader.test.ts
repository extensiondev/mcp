import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import * as bridge from "extension-develop/bridge";
import { readReadyContract, readyContractPath } from "../lib/session-paths";
import { handler as doctorHandler } from "../tools/doctor";
import { handler as logsHandler } from "../tools/logs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ready-reader-"));
  tmpDirs.push(dir);
  return dir;
}

function writeContractText(
  projectPath: string,
  browser: string,
  text: string,
): void {
  const file = readyContractPath(projectPath, browser);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function writeContract(
  projectPath: string,
  browser: string,
  body: Record<string, unknown>,
): void {
  writeContractText(projectPath, browser, JSON.stringify(body));
}

function stubEngineCli(projectPath: string, stdout: string): void {
  const binDir = path.join(projectPath, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "extension");
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\n`);
  fs.chmodSync(bin, 0o755);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("the engine publishes the ready-contract reader", () => {
  it("exports it, and the owner module re-exports that exact function", () => {
    const published = (bridge as unknown as Record<string, unknown>)
      .readReadyContract;
    expect(
      published,
      "extension-develop/bridge no longer exports readReadyContract: tools/logs.ts would have to parse ready.json by hand again",
    ).toBeTypeOf("function");
    expect(readReadyContract).toBe(published);
  });
});

/* @invariant These are the cases tools/logs.ts used to handle in a local copy of
   this function. Deleting that copy is only safe if the engine's version answers
   every one of them identically, so each case below is written as the behaviour
   the deleted code had, not as a description of the engine. A future engine that
   starts returning a partial object where the copy returned null would make
   readFromStream dial ws://127.0.0.1:undefined and report a transport failure
   instead of "no active control channel", which is the wrong diagnosis for a
   session that never opened one. */
describe("the engine's reader on every edge the deleted copy covered", () => {
  it("returns null when no contract has ever been written", () => {
    expect(readReadyContract(tmpProject(), "chrome")).toBeNull();
  });

  it("returns null when the file is not JSON at all", () => {
    const project = tmpProject();
    writeContractText(project, "chrome", "not json at all");
    expect(readReadyContract(project, "chrome")).toBeNull();
  });

  it("returns null for a contract caught mid-write", () => {
    const project = tmpProject();
    const whole = JSON.stringify({
      status: "ready",
      controlPort: 51515,
      instanceId: "inst-1",
      runId: "run-1",
    });
    writeContractText(project, "chrome", whole.slice(0, whole.length - 12));
    expect(readReadyContract(project, "chrome")).toBeNull();
  });

  it("returns null for an empty file", () => {
    const project = tmpProject();
    writeContractText(project, "chrome", "");
    expect(readReadyContract(project, "chrome")).toBeNull();
  });

  it("returns null for a JSON document that is not an object", () => {
    const project = tmpProject();
    writeContractText(project, "chrome", "null");
    expect(readReadyContract(project, "chrome")).toBeNull();
  });

  it("returns null when controlPort is absent", () => {
    const project = tmpProject();
    writeContract(project, "chrome", { status: "ready", instanceId: "inst-1" });
    expect(readReadyContract(project, "chrome")).toBeNull();
  });

  it("returns null when controlPort is null, the shape a session with no bridge writes", () => {
    const project = tmpProject();
    writeContract(project, "chrome", {
      status: "ready",
      controlPort: null,
      instanceId: "inst-1",
    });
    expect(readReadyContract(project, "chrome")).toBeNull();
  });

  it("returns null when controlPort arrives as a string", () => {
    const project = tmpProject();
    writeContract(project, "chrome", {
      status: "ready",
      controlPort: "51515",
      instanceId: "inst-1",
    });
    expect(readReadyContract(project, "chrome")).toBeNull();
  });

  it("returns null when instanceId is absent or empty", () => {
    const project = tmpProject();
    writeContract(project, "chrome", { status: "ready", controlPort: 51515 });
    expect(readReadyContract(project, "chrome")).toBeNull();
    writeContract(project, "firefox", {
      status: "ready",
      controlPort: 51515,
      instanceId: "",
    });
    expect(readReadyContract(project, "firefox")).toBeNull();
  });

  it("coerces instanceId and runId to strings", () => {
    const project = tmpProject();
    writeContract(project, "chrome", {
      status: "ready",
      controlPort: 51515,
      instanceId: 42,
      runId: 7,
    });
    expect(readReadyContract(project, "chrome")).toMatchObject({
      controlPort: 51515,
      instanceId: "42",
      runId: "7",
    });
  });

  it("gives an empty runId rather than undefined when the contract omits it", () => {
    const project = tmpProject();
    writeContract(project, "chrome", {
      status: "ready",
      controlPort: 51515,
      instanceId: "inst-1",
    });
    expect(readReadyContract(project, "chrome")?.runId).toBe("");
  });

  it("reads a full contract through the browser-keyed path", () => {
    const project = tmpProject();
    writeContract(project, "firefox", {
      status: "ready",
      controlPort: 51515,
      instanceId: "inst-1",
      runId: "run-1",
    });
    expect(readReadyContract(project, "firefox")).toMatchObject({
      controlPort: 51515,
      instanceId: "inst-1",
      runId: "run-1",
    });
    expect(readReadyContract(project, "chrome")).toBeNull();
  });
});

describe("tools/logs.ts reads the contract through the engine, with no copy left", () => {
  it("declares no local reader and imports the owner module's", () => {
    const source = fs.readFileSync(path.join(SRC, "tools", "logs.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/function\s+readReadyContract\s*\(/);
    expect(code).toMatch(
      /import\s*\{[^}]*readReadyContract[^}]*\}\s*from\s*["']\.\.\/lib\/session-paths["']/s,
    );
  });

  /* @invariant The refusal a follow read gives when the contract cannot name a
     control channel. Every null case above lands here, and it has to keep saying
     "no active control channel" and pointing at extension_dev: a caller told
     instead that a socket failed goes looking for a port that was never opened. */
  for (const [label, body] of [
    ["a contract with no control port", { status: "ready", instanceId: "i" }],
    [
      "a contract whose control port is null",
      { status: "ready", controlPort: null, instanceId: "i" },
    ],
    [
      "a contract with no instanceId",
      { status: "ready", controlPort: 51515 },
    ],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`refuses to follow ${label}`, async () => {
      const project = tmpProject();
      writeContract(project, "chromium", body);

      const out = JSON.parse(
        await logsHandler({
          projectPath: project,
          browser: "chromium",
          follow: true,
          followMs: 1000,
        }),
      );

      expect(out.ok).toBe(false);
      expect(out.status).toBe("no-control-channel");
      expect(out.error.code).toBe("E_NO_CONTROL_CHANNEL");
      expect(out.hint).toMatch(/extension_dev/);
    }, 15000);
  }

  it("refuses to follow a contract caught mid-write", async () => {
    const project = tmpProject();
    const whole = JSON.stringify({
      status: "ready",
      controlPort: 51515,
      instanceId: "inst-1",
    });
    writeContractText(project, "chromium", whole.slice(0, 20));

    const out = JSON.parse(
      await logsHandler({
        projectPath: project,
        browser: "chromium",
        follow: true,
        followMs: 1000,
      }),
    );

    expect(out.ok).toBe(false);
    expect(out.status).toBe("no-control-channel");
  }, 15000);
});

/* @invariant Why tools/doctor.ts does NOT share the reader above, stated as a
   falsifiable claim so it fails the day it stops being true.

   The engine's reader exists to answer one question: can this process dial the
   control channel. It therefore returns null whenever controlPort is not a
   number or instanceId is missing, and it drops every field doctor's verdict is
   built from (code, errors, message). Both are correct for a follow read and
   both are wrong for a diagnosis.

   The shape that proves it is a session that compiled with errors and has no
   control port. That is not a hypothetical: the engine's dev server catches a
   failure to bind the control server and keeps running with bridgeControlPort
   left at null, and a one-shot `extension build` receipt never sets one at all.
   In both cases ready.json says status:"error" and carries the compile errors,
   and in both cases the engine's reader answers null. Routing doctor through it
   would silently drop the runtime-errors check on exactly the session the caller
   ran doctor to understand, and report healthy. */
describe("tools/doctor.ts keeps its own reader, and this is the difference", () => {
  const erroredWithNoBridge = {
    schemaVersion: 2,
    schema: 1,
    status: "error",
    command: "build",
    browser: "chrome",
    controlPort: null,
    code: "compile_error",
    message: "Compilation failed",
    errors: ["ERROR in ./src/background.ts: Cannot find module './missing'"],
    pid: process.pid,
  };

  it("does not import the engine's reader, and no longer shadows its name", () => {
    const source = fs.readFileSync(path.join(SRC, "tools", "doctor.ts"), "utf8");
    expect(source).not.toMatch(/import\s*\{[^}]*\breadReadyContract\b/s);
    expect(source).not.toMatch(/function\s+readReadyContract\s*\(/);
  });

  it("has the engine's reader answer null for it", () => {
    const project = tmpProject();
    writeContract(project, "chrome", erroredWithNoBridge);
    expect(readReadyContract(project, "chrome")).toBeNull();
  });

  posixOnly(
    "still reports the runtime-errors failure doctor exists to report",
    async () => {
      const project = tmpProject();
      stubEngineCli(project, "[]");
      writeContract(project, "chrome", erroredWithNoBridge);

      const out = JSON.parse(
        await doctorHandler({ projectPath: project, browser: "chrome" }),
      );

      const runtime = (
        out.value.checks as Array<{ check: string; status: string; detail: string }>
      ).find((c) => c.check === "runtime-errors");
      expect(
        runtime,
        "doctor lost the runtime-errors check for an errored session with no control port",
      ).toBeDefined();
      expect(runtime!.status).toBe("fail");
      expect(runtime!.detail).toContain("Cannot find module");
      expect(out.ok).toBe(false);
      expect(out.status).toBe("unhealthy");
    },
    30_000,
  );

  posixOnly(
    "reads the verdict fields the engine's reader drops even from a dialable contract",
    async () => {
      const project = tmpProject();
      stubEngineCli(project, "[]");
      writeContract(project, "chrome", {
        ...erroredWithNoBridge,
        controlPort: 51515,
        instanceId: "inst-1",
      });

      const carried = readReadyContract(project, "chrome");
      expect(carried, "the contract is dialable, so this is not the null case")
        .not.toBeNull();
      for (const field of ["code", "errors", "message"]) {
        expect(
          (carried as unknown as Record<string, unknown>)[field],
          `the engine's reader now carries ${field}; doctor could stop parsing for itself`,
        ).toBeUndefined();
      }

      const out = JSON.parse(
        await doctorHandler({ projectPath: project, browser: "chrome" }),
      );

      const runtime = (
        out.value.checks as Array<{ check: string; status: string; detail: string }>
      ).find((c) => c.check === "runtime-errors");
      expect(runtime?.detail).toContain("Cannot find module");
    },
    30_000,
  );
});
