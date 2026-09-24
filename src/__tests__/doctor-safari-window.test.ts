import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const cli = vi.hoisted(() => ({
  response: { code: 0, stdout: "[]", stderr: "" },
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

vi.mock("../lib/process-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/process-manager")>()),
  listSessions: () => [],
  listSessionMarkers: () => [],
}));

import { handler } from "../tools/doctor";
import { readyContractPath } from "../lib/session-paths";

const tmpDirs: string[] = [];
let server: http.Server | null = null;

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-doctor-safari-"));
  tmpDirs.push(dir);
  return dir;
}

function writeContract(dir: string, contract: unknown): void {
  const ready = readyContractPath(dir, "safari");
  fs.mkdirSync(path.dirname(ready), { recursive: true });
  fs.writeFileSync(ready, JSON.stringify(contract));
}

async function answeringDriver(): Promise<number> {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ value: "https://example.test/" }));
  });
  await new Promise<void>((resolve) =>
    server?.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

afterEach(async () => {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  server = null;
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function legOf(parsed: { value: { checks: Array<{ check: string }> } }) {
  return parsed.value.checks.find((c) => c.check === "safari-window") as
    | { status: string; detail: string; remediation?: string }
    | undefined;
}

describe("extension_doctor's safari-window leg", () => {
  it("passes while the recorded session answers", async () => {
    const dir = tmpProject();
    const port = await answeringDriver();
    writeContract(dir, {
      status: "ready",
      browser: "safari",
      pid: process.pid,
      webdriverPort: port,
      webdriverSessionId: "S-1",
    });
    const parsed = JSON.parse(await handler({ projectPath: dir, browser: "safari" }));
    const leg = legOf(parsed);
    expect(leg?.status).toBe("pass");
    expect(leg?.detail).toContain(`port ${port}`);
    expect(parsed.ok).toBe(true);
  });

  it("fails when the recorded session no longer answers", async () => {
    const dir = tmpProject();
    const port = await answeringDriver();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    writeContract(dir, {
      status: "ready",
      browser: "safari",
      pid: process.pid,
      webdriverPort: port,
      webdriverSessionId: "S-1",
    });
    const parsed = JSON.parse(await handler({ projectPath: dir, browser: "safari" }));
    const leg = legOf(parsed);
    expect(leg?.status).toBe("fail");
    expect(leg?.detail).toContain("no longer answers");
    expect(leg?.remediation).toContain("extension_dev --browser=safari");
    expect(parsed.ok).toBe(false);
  });

  it("fails with the Safari hint when no session was recorded", async () => {
    const dir = tmpProject();
    writeContract(dir, { status: "ready", browser: "safari", pid: process.pid });
    const parsed = JSON.parse(await handler({ projectPath: dir, browser: "safari" }));
    const leg = legOf(parsed);
    expect(leg?.status).toBe("fail");
    expect(leg?.remediation).toContain("one automation session");
  });

  it("adds no such leg on a Chromium session", async () => {
    const dir = tmpProject();
    const ready = readyContractPath(dir, "chrome");
    fs.mkdirSync(path.dirname(ready), { recursive: true });
    fs.writeFileSync(
      ready,
      JSON.stringify({ status: "ready", browser: "chrome", pid: process.pid }),
    );
    const parsed = JSON.parse(await handler({ projectPath: dir, browser: "chrome" }));
    expect(legOf(parsed)).toBeUndefined();
  });
});
