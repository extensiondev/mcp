import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveSessionBrowser,
  knownSessionBrowsers,
} from "../lib/session-browser";
import { toMcpSpeak } from "../lib/act";
import { registerSession, removeSession } from "../lib/process-manager";

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-session-browser-"));
  tmpDirs.push(dir);
  return dir;
}

function writeContract(
  projectPath: string,
  browser: string,
  contract: Record<string, unknown> = { status: "ready" },
): void {
  const dir = path.join(projectPath, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify(contract));
}

const registered: Array<{ projectPath: string; browser: string }> = [];
function register(projectPath: string, browser: string): void {
  registerSession({ pid: process.pid, browser, projectPath, command: "dev" });
  registered.push({ projectPath, browser });
}

afterEach(() => {
  for (const { projectPath, browser } of registered.splice(0)) {
    removeSession(projectPath, browser);
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveSessionBrowser", () => {
  it("explicit browser always wins", () => {
    const project = tmpProject();
    register(project, "chrome");
    expect(resolveSessionBrowser(project, "firefox")).toEqual({
      browser: "firefox",
      source: "explicit",
    });
  });

  it("falls back to the tool default with no session anywhere", () => {
    const project = tmpProject();
    expect(resolveSessionBrowser(project, undefined)).toEqual({
      browser: "chromium",
      source: "fallback",
    });
    expect(resolveSessionBrowser(project, undefined, "chrome")).toEqual({
      browser: "chrome",
      source: "fallback",
    });
  });

  it("uses the in-memory session's browser (the walk's friction #1)", () => {
    const project = tmpProject();
    register(project, "chrome");
    expect(resolveSessionBrowser(project, undefined)).toEqual({
      browser: "chrome",
      source: "session",
    });
  });

  it("most recently registered session wins when several exist", () => {
    const project = tmpProject();
    register(project, "chrome");
    register(project, "firefox");
    expect(resolveSessionBrowser(project, undefined).browser).toBe("firefox");
  });

  it("ignores sessions from other projects", () => {
    const project = tmpProject();
    const other = tmpProject();
    register(other, "edge");
    expect(resolveSessionBrowser(project, undefined).source).toBe("fallback");
  });

  it("matches sessions across relative/absolute path spellings", () => {
    const project = tmpProject();
    register(project + path.sep, "chrome");
    expect(resolveSessionBrowser(project, undefined).browser).toBe("chrome");
  });

  it("falls back to a ready contract on disk after an MCP restart", () => {
    const project = tmpProject();
    writeContract(project, "firefox", { status: "ready", pid: process.pid });
    expect(resolveSessionBrowser(project, undefined)).toEqual({
      browser: "firefox",
      source: "contract",
    });
  });

  it("skips contracts whose pid is dead and non-ready contracts", () => {
    const project = tmpProject();
    // 2^30 is far above any real pid ulimit -> reliably dead.
    writeContract(project, "chrome", { status: "ready", pid: 2 ** 30 });
    writeContract(project, "edge", { status: "error" });
    expect(resolveSessionBrowser(project, undefined).source).toBe("fallback");
  });
});

describe("knownSessionBrowsers", () => {
  it("merges registry sessions and live disk contracts, deduped", () => {
    const project = tmpProject();
    register(project, "chrome");
    writeContract(project, "chrome", { status: "ready", pid: process.pid });
    writeContract(project, "firefox", { status: "ready", pid: process.pid });
    expect(knownSessionBrowsers(project).sort()).toEqual([
      "chrome",
      "firefox",
    ]);
  });

  it("is empty with no sessions", () => {
    expect(knownSessionBrowsers(tmpProject())).toEqual([]);
  });
});

describe("toMcpSpeak", () => {
  it("rewrites the CLI no-channel hint to the tool surface", () => {
    const cli =
      "No active control channel found for chromium. Run `extension dev --browser=chromium --allow-control` first.";
    expect(toMcpSpeak(cli)).toBe(
      'No active control channel found for chromium. Run extension_dev with { browser: "chromium", allowControl: true } first.',
    );
  });

  it("rewrites bare --allow-control / --allow-eval mentions", () => {
    expect(toMcpSpeak("Is the session started with --allow-control?")).toBe(
      "Is the session started with allowControl: true (extension_dev)?",
    );
    expect(toMcpSpeak("eval requires --allow-eval")).toBe(
      "eval requires allowEval: true (extension_dev)",
    );
  });

  it("rewrites stray --browser flags and bare CLI command mentions", () => {
    expect(toMcpSpeak("retry with --browser=firefox")).toBe(
      'retry with browser: "firefox"',
    );
    expect(toMcpSpeak("start extension dev first")).toBe(
      "start extension_dev first",
    );
  });

  it("leaves ordinary prose untouched", () => {
    const msg = "Tab 12 not found in the running session.";
    expect(toMcpSpeak(msg)).toBe(msg);
  });
});
