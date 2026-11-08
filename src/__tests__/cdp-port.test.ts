import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RDP_PORT_MISSING_HINT, rdpPortMissingHint, resolveCdpPort, resolveRdpPort } from "../lib/cdp-port";
import { writeModernContract } from "./fixtures/ready-contract";

let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cdp-port-"));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeCdp(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome/151" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        close: () => server.close(),
      });
    });
  });
}

describe("resolveCdpPort dials only the project's own live session", () => {
  it("answers null for a project with no contract and dials no debug port at all", async () => {
    const cdp = await fakeCdp();
    const get = vi.spyOn(http, "get");

    try {
      const resolved = await resolveCdpPort(dir, "chrome", { waitMs: 50 });
      expect(resolved).toBeNull();
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      cdp.close();
    }
  });

  it("answers the contract's port while the dev server that wrote it is alive", async () => {
    writeModernContract(dir, "chrome", { cdpPort: 9555, pid: process.pid });

    expect(await resolveCdpPort(dir, "chrome", { waitMs: 50 })).toEqual({
      port: 9555,
      source: "contract",
    });
  });

  it("answers null for a contract whose dev server is dead, so a reused port is never dialled", async () => {
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((r) => dead.on("exit", r));
    writeModernContract(dir, "chrome", { cdpPort: 9555, pid: dead.pid });

    expect(await resolveCdpPort(dir, "chrome", { waitMs: 50 })).toBeNull();
  });

  it("answers null for a contract whose pid now belongs to a stranger", async () => {
    if (process.platform === "win32") return;

    const stranger = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    stranger.unref();
    children.push(stranger);
    await new Promise((r) => setTimeout(r, 200));
    writeModernContract(dir, "chrome", { cdpPort: 9555, pid: stranger.pid });

    expect(await resolveCdpPort(dir, "chrome", { waitMs: 50 })).toBeNull();
  });
});

describe("resolveRdpPort reads the engine's verdict on the Firefox debug port", () => {
  it("answers at once with the engine's rdpPortError instead of polling for a port that will not come", async () => {
    writeModernContract(dir, "firefox", { cdpPort: undefined, pid: process.pid, rdpPortError: "Firefox did not open its remote debugging port 6000 within 30000ms." });

    const started = Date.now();
    const resolved = await resolveRdpPort(dir, "firefox", { waitMs: 3_000, graceMs: 1_000 });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(resolved).toEqual({ port: null, rdpPortError: "Firefox did not open its remote debugging port 6000 within 30000ms" });
    expect(rdpPortMissingHint(resolved)).toBe("Firefox opened no debugger (RDP) port on this run: the engine says Firefox did not open its remote debugging port 6000 within 30000ms; extension_logs shows the launcher's last lines, and extension_dev with replace: true starts a new session.");
  });

  it("still waits out the grace on a contract with neither field, and the hint names the 4.1.39 floor and both older eras", async () => {
    writeModernContract(dir, "firefox", { cdpPort: undefined, pid: process.pid });

    const started = Date.now();
    const resolved = await resolveRdpPort(dir, "firefox", { waitMs: 3_000, graceMs: 600 });

    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(resolved).toBeNull();
    expect(rdpPortMissingHint(resolved)).toBe(RDP_PORT_MISSING_HINT);
    expect(RDP_PORT_MISSING_HINT).toMatch(/From Extension\.js 4\.1\.39 a Firefox dev session turns ready only with rdpPort or rdpPortError/);
    expect(RDP_PORT_MISSING_HINT).toMatch(/after ready \(4\.0\.15 on\) or never \(before 4\.0\.15\)/);
    expect(RDP_PORT_MISSING_HINT).toMatch(/to 4\.1\.39 or later/);
  });
});
