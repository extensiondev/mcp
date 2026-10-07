import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import { handler as wait } from "../tools/wait";
import { handler as start, schema as startSchema } from "../tools/start";
import { readyContractPath } from "../lib/session-paths";

const dirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wave3-"));
  dirs.push(dir);

  return dir;
}

function contract(dir: string, body: Record<string, unknown>): void {
  const file = readyContractPath(dir, "chrome");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("94: wait and start say what they observed", () => {
  it("94f: no session and no contract is no-session, not 'still building'", async () => {
    const out = JSON.parse(await wait({ projectPath: project(), browser: "chrome", timeoutMs: 1100 }));
    expect(out.status).toBe("no-session");
    expect(out.error.code).toBe("E_NO_SESSION");
    expect(JSON.stringify(out)).not.toMatch(/Still building/);
  }, 10_000);

  it("94g: a finished build's contract is not a session", async () => {
    const dir = project();
    contract(dir, { schema: 1, status: "ready", command: "build", pid: 999999, browser: "chrome" });
    const out = JSON.parse(await wait({ projectPath: dir, browser: "chrome", timeoutMs: 1100 }));
    expect(out.status).toBe("no-session");
    expect(out.error.message).toMatch(/finished extension_build/);
  }, 10_000);

  it("94f: a stopped contract says the session stopped", async () => {
    const dir = project();
    contract(dir, { schema: 1, status: "stopped", command: "dev", pid: process.pid, browser: "chrome" });
    const out = JSON.parse(await wait({ projectPath: dir, browser: "chrome", timeoutMs: 1100 }));
    expect(out.status).toBe("stopped");
  }, 10_000);

  it("94e: start refuses what the engine refuses before spawning", async () => {
    const safari = JSON.parse(await start({ projectPath: project(), browser: "safari" } as never));
    expect(safari.status).toBe("unsupported-browser");
    const host = JSON.parse(await start({ projectPath: project(), build: false, host: "0.0.0.0" } as never));
    expect(host.status).toBe("bad-request");
    expect(host.error.message).toMatch(/not options of the engine's preview verb/);
  });

  it("94d: the schema describes noBrowser and port as the engine runs them", () => {
    const props = startSchema.inputSchema.properties as unknown as Record<string, { description: string }>;
    expect(props.noBrowser.description).toMatch(/process ends once the build does/);
    expect(props.port.description).not.toBe("Server port (0 for auto-assign)");
  });
});
