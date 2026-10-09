import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import { handler as wait, schema } from "../tools/wait";
import { readyContractPath } from "../lib/session-paths";
import { attachedDevContract, readyContract } from "./fixtures/engine-answers";

const dirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wait-ports-"));
  dirs.push(dir);

  return dir;
}

function contract(dir: string, browser: string, body: Record<string, unknown>): void {
  const file = readyContractPath(dir, browser);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...body, pid: process.pid, distPath: path.join(dir, "dist", browser) }));
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_wait names every port the session bound, so 'tell me the ports' is answered by the tool", () => {
  it("carries the dev server port, the control port and the browser's CDP port out of the contract", async () => {
    const dir = project();
    contract(dir, "chrome", attachedDevContract("chrome", { port: 8080, controlPort: 52246, cdpPort: 9333 }));

    const out = JSON.parse(await wait({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }));

    expect(out.status).toBe("ready");
    expect(out.value).toMatchObject({ port: 8080, controlPort: 52246, cdpPort: 9333 });
    expect(out.value.debugPortNote).toBeUndefined();
  }, 10_000);

  it("says in one field that the session opened no debug port instead of leaving the key out", async () => {
    const dir = project();
    contract(dir, "chrome", attachedDevContract("chrome", { cdpPort: undefined }));

    const out = JSON.parse(await wait({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }));

    expect(out.status).toBe("ready");
    expect(out.value.cdpPort).toBeNull();
    expect(out.value.debugPortNote).toMatch(/no browser debug port/i);
  }, 10_000);

  it("reports a gecko session's RDP port as its debug port", async () => {
    const dir = project();
    contract(dir, "firefox", attachedDevContract("firefox", { cdpPort: undefined, rdpPort: 6000 }));

    const out = JSON.parse(await wait({ projectPath: dir, browser: "firefox", timeoutMs: 1500 }));

    expect(out.status).toBe("ready");
    expect(out.value).toMatchObject({ cdpPort: null, rdpPort: 6000 });
    expect(out.value.debugPortNote).toBeUndefined();
  }, 10_000);

  it("says a production start session opened no debug port", async () => {
    const dir = project();
    contract(dir, "chrome", readyContract("start", "chrome", { compiledAt: new Date().toISOString() }));

    const out = JSON.parse(await wait({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }));

    expect(out.status).toBe("build-ready");
    expect(out.value.cdpPort).toBeNull();
    expect(out.value.debugPortNote).toMatch(/no browser debug port/i);
  }, 10_000);

  it("tells the agent in the description which ports the answer carries", () => {
    expect(schema.description).toMatch(/cdpPort/);
    expect(schema.description).toMatch(/controlPort/);
  });
});
