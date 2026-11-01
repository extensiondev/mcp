// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler } from "../tools/logs";
import { logsPath } from "../lib/session-paths";
import { writeModernContract } from "./fixtures/ready-contract";
import { logHeader } from "./fixtures/engine-answers";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-logs-safari-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function headerOnly(browser: string): void {
  const file = logsPath(dir, browser);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(logHeader("run-1"))}\n`);
}

async function read(browser: string): Promise<{ status: string; warnings: string[] }> {
  return JSON.parse(await handler({ projectPath: dir, browser } as never));
}

describe("extension_logs on Safari names a background that is not connected instead of silence", () => {
  it("says the background never connected when ready.json records no attach", async () => {
    writeModernContract(dir, "safari", { pid: process.pid, runId: "run-1", executorAttachedAt: undefined, runtime: undefined });
    headerOnly("safari");

    const out = await read("safari");
    const text = out.warnings.join(" ");

    expect(out.status).toBe("empty");
    expect(text).toContain("has not connected to the bridge in this run");
    expect(text).toContain("does not mean the extension wrote nothing");
    expect(text).not.toContain("nothing in the extension has logged");
  });

  it("says Safari unloaded the background when it detached after its last attach", async () => {
    writeModernContract(dir, "safari", {
      pid: process.pid,
      runId: "run-1",
      runtime: "detached",
      executorAttachedAt: "2026-10-31T20:00:00.000Z",
      executorDetachedAt: "2026-10-31T20:00:30.000Z",
    });

    headerOnly("safari");

    const text = (await read("safari")).warnings.join(" ");

    expect(text).toContain("Safari unloaded its background at 2026-10-31T20:00:30.000Z");
    expect(text).not.toContain("nothing in the extension has logged");
  });

  it("keeps the plain wording while the Safari background is connected", async () => {
    writeModernContract(dir, "safari", { pid: process.pid, runId: "run-1" });
    headerOnly("safari");

    expect((await read("safari")).warnings.join(" ")).toContain("nothing in the extension has logged");
  });

  it("keeps the plain wording on Chromium with no attach recorded", async () => {
    writeModernContract(dir, "chrome", { pid: process.pid, runId: "run-1", executorAttachedAt: undefined, runtime: undefined });
    headerOnly("chrome");

    expect((await read("chrome")).warnings.join(" ")).toContain("nothing in the extension has logged");
  });
});
