import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import * as wait from "../tools/wait";
import { deadReadySession } from "../lib/session-browser";
import { readyContract } from "./fixtures/engine-answers";

const dirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wait-start-"));
  dirs.push(dir);

  return dir;
}

function writeContract(projectPath: string, browser: string, contract: Record<string, unknown>): void {
  const dir = path.join(projectPath, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ready.json"),
    JSON.stringify(readyContract("start", browser, { distPath: path.join(projectPath, "dist", browser), ts: new Date().toISOString(), ...contract })),
  );
}

const servers: http.Server[] = [];

function debugPort(targets: Array<{ type: string; url: string }>): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(targets.map((t, i) => ({ id: `t${i}`, title: "", webSocketDebuggerUrl: "", ...t }))));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  for (const s of servers.splice(0)) s.close();
});

describe("extension_wait on a start session says at once that nothing will attach", () => {
  it("answers launched with the production-build guidance instead of burning the budget on E_NOT_ATTACHED", async () => {
    const project = tmpProject();
    writeContract(project, "chrome", {
      command: "start",
      pid: process.pid,
      port: 8080,
      toolchainVersion: "4.1.33",
      compiledAt: new Date().toISOString(),
    });

    const started = Date.now();

    const result = JSON.parse(
      await wait.handler({ projectPath: project, browser: "chrome", timeoutMs: 90_000 }),
    );

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("build-ready");
    expect(result.value).toMatchObject({ compiled: true, browserAttached: false, sessionCommand: "start" });
    expect(result.hint).toContain("extension_start session");
    expect(result.hint).toContain("This engine (Extension.js 4.1.33) opens no debug port on a production run (4.1.34 is the first that does), so the browser's target list cannot be read from here, and only extension_dev proves the load (its answer carries guestLoaded); browserAttached stays false for good, so do not call extension_wait again.");
    expect(result.hint).toContain("extension_build");
    expect(result.warnings.join(" ")).toContain("clamped to 50000ms");
  }, 20_000);

  it("answers browserAttached: true and says the load is proven over the debug port, never sending the caller to extension_dev", async () => {
    const project = tmpProject();
    const id = "dpnieppbnngfepobhbkmnjjgneiciafo";
    const cdpPort = await debugPort([
      { type: "service_worker", url: `chrome-extension://${id}/background.js` },
      { type: "page", url: `chrome-extension://${id}/popup.html` },
    ]);
    writeContract(project, "chrome", {
      command: "start",
      pid: process.pid,
      port: null,
      toolchainVersion: "4.1.36",
      browserPid: process.pid,
      extensionId: id,
      cdpPort,
      compiledAt: new Date().toISOString(),
    });

    const result = JSON.parse(
      await wait.handler({ projectPath: project, browser: "chrome", timeoutMs: 1500 }),
    );

    expect(result.status).toBe("build-ready");
    expect(result.value).toMatchObject({ compiled: true, browserAttached: true, extensionLoaded: true, cdpPort });
    expect(result.value.loadEvidence).toBe(`Read over the browser's debug port ${cdpPort}: 2 live targets of ${id} (service_worker, page), so the browser loaded the extension.`);
    expect(result.hint).toContain(`and the browser loaded the extension (${result.value.loadEvidence})`);
    expect(result.hint).toContain(`The load is proven over the debug port ${cdpPort}, which extension_open {url}, extension_assert, extension_screenshot and extension_dom_snapshot by url read now; nothing here needs extension_dev.`);
    expect(result.hint).toContain("extension_storage, extension_reload, extension_open with a surface, extension_dom_snapshot by tab and extension_eval need extension_start again with allowControl: true and replace: true.");
    expect(result.hint).not.toMatch(/To prove the load|Do not call extension_wait again|stays false/);
  }, 10_000);

  it("says to call extension_wait again while a 4.1.34 or later engine has not stamped cdpPort yet", async () => {
    const project = tmpProject();
    writeContract(project, "chrome", {
      command: "start",
      pid: process.pid,
      port: null,
      toolchainVersion: "4.1.36",
      browserPid: process.pid,
      compiledAt: new Date().toISOString(),
    });

    const result = JSON.parse(
      await wait.handler({ projectPath: project, browser: "chrome", timeoutMs: 1500 }),
    );

    expect(result.status).toBe("build-ready");
    expect(result.value).toMatchObject({ browserAttached: false, extensionLoaded: null, cdpPort: null });
    expect(result.value.debugPortNote).toBe("This start session names no browser debug port yet: the engine (Extension.js 4.1.36) stamps cdpPort once the browser binds it, so call extension_wait again for it.");
    expect(result.hint).toContain(`Call extension_wait {projectPath: ${JSON.stringify(project)}, browser: "chrome"} again: the engine (Extension.js 4.1.36) stamps the browser's debug port (cdpPort) in the contract once the browser binds it, and extension_wait reads the load off that port's target list.`);
    expect(result.hint).not.toMatch(/opens no debug port|Do not call extension_wait again|run it with extension_dev/);
  }, 10_000);

  it("does not call a session with a control port undrivable while its background has not connected", async () => {
    const project = tmpProject();
    writeContract(project, "firefox", {
      command: "preview",
      pid: process.pid,
      port: null,
      controlPort: 61110,
      compiledAt: new Date().toISOString(),
    });

    const result = JSON.parse(
      await wait.handler({ projectPath: project, browser: "firefox", timeoutMs: 1500 }),
    );

    expect(result.status).toBe("build-ready");
    expect(result.hint).not.toMatch(/carries no dev bridge|cannot drive it/);
    expect(result.hint).toMatch(/control channel \(port 61110\)/);
  }, 10_000);

  it("answers launched for a preview session too, which the engine stamps as command preview", async () => {
    const project = tmpProject();
    writeContract(project, "chrome", {
      command: "preview",
      pid: process.pid,
      port: null,
      compiledAt: new Date().toISOString(),
    });

    const started = Date.now();

    const result = JSON.parse(
      await wait.handler({ projectPath: project, browser: "chrome", timeoutMs: 1500 }),
    );

    expect(Date.now() - started).toBeLessThan(1400);
    expect(result.status).toBe("build-ready");
    expect(result.value.sessionCommand).toBe("preview");
    expect(result.hint).toContain("prebuilt dist");
  }, 10_000);

  it("keeps waiting on a dev session that has compiled but not attached, and says when the budget was clamped", async () => {
    const project = tmpProject();
    writeContract(project, "chrome", {
      command: "dev",
      pid: process.pid,
      port: 8080,
      compiledAt: new Date().toISOString(),
    });

    const result = JSON.parse(
      await wait.handler({ projectPath: project, browser: "chrome", timeoutMs: 1_000 }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NOT_ATTACHED");
    expect(result.warnings.join(" ")).not.toContain("clamped");
  }, 15_000);
});

describe("a dead contract explains only the browser the call named", () => {
  it("does not blame a chrome call on firefox's stale contract", () => {
    const project = tmpProject();
    writeContract(project, "chrome", { command: "dev", pid: process.pid });
    writeContract(project, "firefox", { command: "dev", pid: 999_999_999 });

    expect(deadReadySession(project, "chrome")).toBeNull();
    expect(deadReadySession(project, "firefox")).toMatchObject({ browser: "firefox", pid: 999_999_999 });
    expect(deadReadySession(project)).toMatchObject({ browser: "firefox" });
  });
});
