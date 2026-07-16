import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCdpPort } from "../lib/cdp-port";
import { resolveExtensionInvocation } from "../lib/exec";
import {
  knownSessionBrowsers,
  resolveSessionBrowser,
} from "../lib/session-browser";
import { handler as stopHandler } from "../tools/stop";
import {
  writeModernContract,
  writeLegacyContract,
  writeErrorContract,
  writeLegacyEngineState,
} from "./fixtures/ready-contract";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-legacy-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("legacy ready-contract compatibility", () => {
  it("resolveCdpPort returns null (not a bogus probe) for a portless legacy contract", async () => {
    writeLegacyContract(dir, "chrome");
    // A contract EXISTS but has no cdpPort: probing 9222 here could adopt an
    // unrelated developer Chrome, so the resolver must give up instead.
    const resolved = await resolveCdpPort(dir, "chrome", { waitMs: 700 });
    expect(resolved).toBeNull();
  });

  it("resolveCdpPort picks up a cdpPort stamped mid-poll", async () => {
    writeLegacyContract(dir, "chrome");
    setTimeout(() => {
      writeModernContract(dir, "chrome", { cdpPort: 9444 });
    }, 300);
    const resolved = await resolveCdpPort(dir, "chrome", { waitMs: 5_000 });
    expect(resolved).toEqual({ port: 9444, source: "contract" });
  });

  it("session-browser keeps a pid-less legacy sighting", () => {
    // Old contracts carry no pid; absence of liveness data must not read as
    // dead, or every 4.0.6 session would be invisible to browser defaulting.
    writeLegacyContract(dir, "chrome");
    expect(knownSessionBrowsers(dir)).toContain("chrome");
    expect(resolveSessionBrowser(dir, undefined)).toEqual({
      browser: "chrome",
      source: "contract",
    });
  });

  it("session-browser drops a modern contract whose pid is dead", () => {
    writeModernContract(dir, "chrome", { pid: 999999 });
    expect(knownSessionBrowsers(dir)).not.toContain("chrome");
  });

  it("session-browser skips non-ready contracts", () => {
    writeErrorContract(dir, "chrome");
    expect(knownSessionBrowsers(dir)).not.toContain("chrome");
  });

  it("stop reports not-found (no throw) for a pid-less legacy contract", async () => {
    writeLegacyContract(dir, "chrome");
    const result = JSON.parse(
      await stopHandler({ projectPath: dir, browser: "chrome" }),
    );
    const outcome = Array.isArray(result.results) ? result.results[0] : result;
    expect(outcome.stopped).toBe(false);
    expect(outcome.pid).toBeNull();
  });

  it("EXTENSION_MCP_CLI_VERSION overrides the npx pin", () => {
    const prev = process.env.EXTENSION_MCP_CLI_VERSION;
    process.env.EXTENSION_MCP_CLI_VERSION = "9.9.9-skewtest.1";
    try {
      const { command, prefixArgs } = resolveExtensionInvocation();
      expect(command).toBe("npx");
      expect(prefixArgs).toEqual(["extension@9.9.9-skewtest.1"]);
    } finally {
      if (prev === undefined) delete process.env.EXTENSION_MCP_CLI_VERSION;
      else process.env.EXTENSION_MCP_CLI_VERSION = prev;
    }
  });

  it("ignores legacy engine-state files (port slot, shared token)", () => {
    // These belong to the engine, not the MCP. If an MCP feature ever starts
    // reading them, this is the fixture to extend — until then their mere
    // presence must not conjure a session.
    writeLegacyEngineState(dir, "chrome");
    expect(knownSessionBrowsers(dir)).toEqual([]);
    expect(resolveSessionBrowser(dir, undefined).source).toBe("fallback");
  });
});
