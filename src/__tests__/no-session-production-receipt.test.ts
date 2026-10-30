import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CDP_PORT_MISSING_HINT } from "../lib/cdp-port";
import { noSessionEnvelope, noSessionWords, productionSessionContext } from "../lib/production-receipt";
import { runActVerb } from "../lib/act";
import { registerSession, removeSession } from "../lib/process-manager";
import { navigateToUrl } from "../tools/open";
import { readyContract } from "./fixtures/engine-answers";

import type * as ExecModule from "../lib/exec";

const exec = vi.hoisted(() => ({
  result: { code: 1, stdout: "", stderr: "", timedOut: false, signal: null as string | null },
}));

vi.mock("../lib/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof ExecModule>()),
  runExtensionCli: async () => exec.result,
}));

const dirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-no-session-receipt-"));
  dirs.push(dir);

  return dir;
}

function writeContract(projectPath: string, browser: string, command: "dev" | "start" | "preview" | "build", contract: Record<string, unknown>): string {
  const dir = path.join(projectPath, "dist", "extension-js", browser);
  const file = path.join(dir, "ready.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(readyContract(command, browser, { ts: new Date().toISOString(), ...contract })));

  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const DEV = {
  message: `No active dev session / CDP port for chrome. Start extension_dev and extension_wait for ready. ${  CDP_PORT_MISSING_HINT}`,
};

describe("the no-session answer reads the start receipt before choosing its words", () => {
  it("says the production session is still starting and names the exact extension_wait call while the receipt is landing", async () => {
    const project = tmpProject();
    const file = writeContract(project, "chrome", "start", { status: "starting", pid: process.pid, controlPort: 56181, cdpPort: undefined, browserPid: undefined });

    const out = JSON.parse(await navigateToUrl(project, "chrome", "https://www.youtube.com/watch?v=05ny1bmo-Kk"));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("no-session");
    expect(out.error).toMatchObject({ code: "E_NO_SESSION", name: "NoSession" });
    expect(out.error.message).toBe(
      `The chrome production session (extension_start) is still starting: ${file} reads status starting, so https://www.youtube.com/watch?v=05ny1bmo-Kk cannot be opened.`,
    );

    expect(out.hint).toBe(
      `Call extension_wait {projectPath: ${JSON.stringify(project)}, browser: "chrome"}, then this call again. Do not start extension_dev for it: that replaces the production session with a dev session.`,
    );

    expect(JSON.stringify(out)).not.toMatch(/Start extension_dev/);
  }, 15_000);

  it("reads a ready receipt that launched the browser but names no cdpPort as the port not stamped yet", () => {
    const project = tmpProject();
    const file = writeContract(project, "chrome", "start", { status: "ready", pid: process.pid, controlPort: 56181, cdpPort: undefined, browserPid: process.pid });

    const words = noSessionWords(project, "chrome", DEV, "so there is no browser to ask for pixels");

    expect(words.message).toBe(
      `The chrome production session (extension_start) names no debug port yet: ${file} reads status ready and the browser it launched (pid ${process.pid}), but no cdpPort, so there is no browser to ask for pixels.`,
    );

    expect(words.hint).toMatch(/^Call extension_wait \{projectPath/);
    expect(words.hint).toMatch(/before Extension\.js 4\.1\.34/);
    expect(words.hint).not.toMatch(/without allowControl/);
  });

  it("says the bridge verbs need allowControl: true when the ready receipt names no controlPort and the registry recorded a launch without it", () => {
    const project = tmpProject();
    writeContract(project, "chrome", "start", { status: "ready", pid: process.pid, controlPort: null, cdpPort: undefined, browserPid: process.pid });
    registerSession({ pid: process.pid, browser: "chrome", projectPath: project, command: "start", allowControl: false });

    try {
      const words = noSessionWords(project, "chrome", DEV);

      expect(words.message).toMatch(/names no debug port yet/);
      expect(words.hint).toMatch(/^Call extension_wait \{projectPath/);
      expect(words.hint).toMatch(/started without allowControl \(this server's session registry recorded the launch, and the ready contract names no controlPort\), so the debug-port reads work while extension_storage, extension_reload, extension_open with a surface, extension_dom_snapshot by tab and extension_eval need extension_start again with allowControl: true and replace: true/);
      expect(words.hint).toMatch(/Do not start extension_dev/);
    } finally {
      removeSession(project, "chrome", process.pid);
    }
  });

  it("never says a starting run was started without allowControl when the registry recorded allowControl: true", () => {
    const project = tmpProject();
    writeContract(project, "chrome", "start", { status: "starting", pid: process.pid, controlPort: null, cdpPort: undefined, browserPid: undefined });
    registerSession({ pid: process.pid, browser: "chrome", projectPath: project, command: "start", allowControl: true });

    try {
      const words = noSessionWords(project, "chrome", DEV);

      expect(words.message).toMatch(/is still starting/);
      expect(words.hint).not.toMatch(/without allowControl/);
      expect(words.hint).toMatch(/This run asked for the control channel \(allowControl: true in this server's session registry\) and the contract has not recorded its port yet; once it lands, extension_storage, extension_reload, extension_open with a surface, extension_dom_snapshot by tab and extension_eval reach it, and the debug-port reads need no control at all\./);
      expect(words.hint).toMatch(/Do not start extension_dev/);
    } finally {
      removeSession(project, "chrome", process.pid);
    }
  });

  it("leaves the control sentence out while the receipt is starting and nothing says whether control was asked for", () => {
    const project = tmpProject();
    writeContract(project, "chrome", "start", { status: "starting", pid: process.pid, controlPort: null, cdpPort: undefined, browserPid: undefined });

    const words = noSessionWords(project, "chrome", DEV);

    expect(words.message).toMatch(/is still starting/);
    expect(words.hint).not.toMatch(/allowControl/);
    expect(words.hint).toMatch(/Do not start extension_dev/);
  });

  it("does not trust a registry entry for another run of the same project and browser", () => {
    const project = tmpProject();
    writeContract(project, "chrome", "start", { status: "ready", pid: process.pid, controlPort: null, cdpPort: undefined, browserPid: process.pid });
    registerSession({ pid: process.pid + 1, browser: "chrome", projectPath: project, command: "start", allowControl: false });

    try {
      expect(noSessionWords(project, "chrome", DEV).hint).not.toMatch(/without allowControl/);
    } finally {
      removeSession(project, "chrome", process.pid + 1);
    }
  });

  it("restarts a run that asked for control with allowControl: true after its engine process is gone", () => {
    const project = tmpProject();
    writeContract(project, "chrome", "start", { status: "starting", pid: 2_147_483_000, controlPort: null, cdpPort: undefined });
    registerSession({ pid: 2_147_483_000, browser: "chrome", projectPath: project, command: "start", allowControl: true });

    try {
      const words = noSessionWords(project, "chrome", DEV);

      expect(words.message).toMatch(/has ended/);
      expect(words.hint).toBe("Call extension_stop to clean up, then extension_start again with allowControl: true.");
    } finally {
      removeSession(project, "chrome", 2_147_483_000);
    }
  });

  it("says a new run is replacing the one that wrote the receipt when this server registered it", () => {
    const project = tmpProject();
    const file = writeContract(project, "chrome", "start", { status: "ready", pid: 2_147_483_000, controlPort: 56181, cdpPort: 9222 });
    registerSession({ pid: process.pid, browser: "chrome", projectPath: project, command: "start" });

    try {
      const words = noSessionWords(project, "chrome", DEV);

      expect(words.message).toBe(
        `The chrome production session (extension_start) is being replaced: the run that wrote ${file} (pid 2147483000) has ended and the new extension_start run (pid ${process.pid}) has not written its receipt yet, so there is no browser to ask yet.`,
      );

      expect(words.hint).toMatch(/^Call extension_wait \{projectPath/);
      expect(words.hint).not.toMatch(/extension_stop/);
    } finally {
      removeSession(project, "chrome", process.pid);
    }
  });

  it("says the run ended when the engine process that wrote the receipt is gone", () => {
    const project = tmpProject();
    writeContract(project, "chrome", "start", { status: "ready", pid: 2_147_483_000, controlPort: 56181, cdpPort: 9222 });

    const words = noSessionWords(project, "chrome", DEV);

    expect(words.message).toMatch(/^The chrome production session \(extension_start\) has ended: its engine process \(pid 2147483000\) is gone/);
    expect(words.hint).toBe("Call extension_stop to clean up, then extension_start again with allowControl: true.");
  });

  it("names the failed build when the receipt reads status error", () => {
    const project = tmpProject();
    writeContract(project, "chrome", "start", { status: "error", pid: process.pid, controlPort: 56181, errors: ["Module not found: ./missing"] });

    const words = noSessionWords(project, "chrome", DEV);

    expect(words.message).toContain("its build failed (Module not found: ./missing)");
    expect(words.hint).toBe("Fix the build error, then call extension_start again with allowControl: true.");
  });

  it("reads a build receipt as a finished extension_build, not a session", () => {
    const project = tmpProject();
    const file = writeContract(project, "chrome", "build", { pid: process.pid });

    const words = noSessionWords(project, "chrome", DEV);

    expect(words.message).toBe(`${file} is the receipt of a finished extension_build (command: build), not a running session, so there is no browser to ask yet.`);
    expect(words.hint).toMatch(/extension_start with allowControl: true/);
  });

  it("keeps the dev wording byte for byte on a dev contract and with no contract", () => {
    const withDev = tmpProject();
    writeContract(withDev, "chrome", "dev", { status: "starting", pid: process.pid });
    const empty = tmpProject();

    expect(noSessionWords(withDev, "chrome", DEV)).toEqual(DEV);
    expect(noSessionWords(empty, "chrome", { ...DEV, hint: CDP_PORT_MISSING_HINT })).toEqual({ ...DEV, hint: CDP_PORT_MISSING_HINT });

    const envelope = JSON.parse(noSessionEnvelope({ command: "extension_open", projectPath: empty, browser: "chrome", need: "so nothing opens", dev: DEV, name: "NoSession" }));
    expect(envelope.error).toEqual({ code: "E_NO_SESSION", name: "NoSession", message: DEV.message });
    expect(envelope.hint).toBeUndefined();
  });
});

describe("the engine's own control refusals carry the receipt's words too", () => {
  it("tells a bridge verb on a production run without control to start again with allowControl, not extension_dev", async () => {
    const project = tmpProject();
    writeContract(project, "chrome", "start", { status: "ready", pid: process.pid, controlPort: null, browserPid: process.pid });
    exec.result = {
      code: 1,
      stdout: JSON.stringify({ schema: 1, ok: false, command: "storage", status: "failed", value: null, error: { code: "E_SESSION_NOT_FOUND", message: "no control channel for chrome" }, warnings: [] }),
      stderr: "",
      timedOut: false,
      signal: null,
    };

    registerSession({ pid: process.pid, browser: "chrome", projectPath: project, command: "start", allowControl: false });

    try {
      const out = JSON.parse(await runActVerb(["storage", "get", "--browser", "chrome"], project));

      expect(out.error.code).toBe("E_SESSION_NOT_FOUND");
      expect(out.error.message).toMatch(/started without allowControl/);
      expect(out.error.message).toMatch(/extension_start again with allowControl: true and replace: true/);
      expect(out.error.message).not.toMatch(/extension_dev without allowControl: false/);
    } finally {
      removeSession(project, "chrome", process.pid);
    }
  });

  it("adds nothing on a controlled production run that is up, so the engine's own refusal stands", () => {
    const project = tmpProject();
    writeContract(project, "chrome", "start", { status: "ready", pid: process.pid, controlPort: 56181, cdpPort: 9222, executorAttachedAt: new Date().toISOString() });

    expect(productionSessionContext(project, "chrome")).toBeNull();
  });
});
