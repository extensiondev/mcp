import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCdpPort } from "../lib/cdp-port";
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
      // gone
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
