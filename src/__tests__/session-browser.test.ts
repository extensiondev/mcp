import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import {
  deadReadySession,
  resolveSessionBrowser,
  knownSessionBrowsers,
  liveProjectSessions,
} from "../lib/session-browser";
import { sessionNotFoundWords, toMcpSpeak, withSessionContext } from "../lib/act";
import { readyContract } from "./fixtures/engine-answers";
import {
  registerSession,
  removeSession,
  removeSessionMarker,
} from "../lib/process-manager";

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-session-browser-"));
  tmpDirs.push(dir);

  return dir;
}

function writeContract(
  projectPath: string,
  browser: string,
  contract: Record<string, unknown> = {},
  command: "dev" | "build" = "dev",
): void {
  const dir = path.join(projectPath, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ready.json"),
    JSON.stringify(readyContract(command, browser, { distPath: path.join(projectPath, "dist", browser), ...contract })),
  );
}

const registered: Array<{ projectPath: string; browser: string }> = [];

function register(projectPath: string, browser: string): void {
  registerSession({ pid: process.pid, browser, projectPath, command: "dev" });
  registered.push({ projectPath, browser });
}

afterEach(() => {
  for (const { projectPath, browser } of registered.splice(0)) {
    removeSession(projectPath, browser);
    removeSessionMarker(projectPath, browser);
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

  it("falls back to chrome, not chromium, with no session anywhere", () => {
    const project = tmpProject();
    expect(resolveSessionBrowser(project, undefined)).toEqual({
      browser: "chrome",
      source: "fallback",
    });

    expect(resolveSessionBrowser(project, undefined, "firefox")).toEqual({
      browser: "firefox",
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

  it("prefers a live contract over a dead one", () => {
    const project = tmpProject();
    writeContract(project, "chrome", { status: "ready", pid: 2 ** 30 });
    writeContract(project, "firefox", { status: "ready", pid: process.pid });
    expect(resolveSessionBrowser(project, undefined)).toEqual({
      browser: "firefox",
      source: "contract",
    });
  });

  it("keeps targeting a dead session's browser instead of the blind default", () => {
    const project = tmpProject();
    writeContract(project, "chrome", { status: "ready", pid: 2 ** 30 });
    writeContract(project, "edge", { status: "error" });
    expect(resolveSessionBrowser(project, undefined)).toEqual({
      browser: "chrome",
      source: "stale",
    });
  });

  it("ignores non-ready contracts entirely", () => {
    const project = tmpProject();
    writeContract(project, "edge", { status: "error" });
    expect(resolveSessionBrowser(project, undefined)).toEqual({
      browser: "chrome",
      source: "fallback",
    });
  });
});

describe("liveProjectSessions", () => {
  it("still sees a live session through its on-disk marker after registry amnesia", () => {
    const project = tmpProject();
    register(project, "chrome");
    removeSession(project, "chrome");

    const sessions = liveProjectSessions(project);

    expect(sessions).toEqual([
      { browser: "chrome", pid: process.pid, source: "marker" },
    ]);
  });

  it("ignores markers whose pid is dead", () => {
    const project = tmpProject();
    registerSession({
      pid: 2 ** 30,
      browser: "chrome",
      projectPath: project,
      command: "dev",
    });

    registered.push({ projectPath: project, browser: "chrome" });
    removeSession(project, "chrome");

    expect(liveProjectSessions(project)).toEqual([]);
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
      'No active control channel found for chromium. Run extension_dev with { browser: "chromium" } (its control channel is on unless allowControl: false) first.',
    );
  });

  it("rewrites bare --allow-control / --allow-eval mentions", () => {
    expect(toMcpSpeak("Is the session started with --allow-control?")).toBe(
      "Is the session started with allowControl (on by default on extension_dev, off only with allowControl: false)?",
    );

    expect(toMcpSpeak("eval requires --allow-eval")).toBe(
      "eval requires allowEval: true on extension_dev",
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

describe("922: a control channel that was not found is worded by what sessions exist", () => {
  const engine =
    'No active control channel found for chrome. Looked at /p/dist/extension-js/chrome/ready.json. Run extension_dev with { browser: "chrome" } (its control channel is on unless allowControl: false) first.';

  it("keeps the engine's words, start a session first, only when the project has none", () => {
    expect(sessionNotFoundWords(engine, "extension_open", "chrome", [])).toEqual({ message: engine, hint: null });
  });

  it("names another browser's session without telling the agent to start one", () => {
    const words = sessionNotFoundWords(engine, "extension_open", "chrome", ["firefox"]);

    expect(words.message).toBe(
      "No active control channel found for chrome. Looked at /p/dist/extension-js/chrome/ready.json. This project's session runs on firefox, not on chrome.",
    );

    expect(words.hint).toBe('Call extension_open again with browser: "firefox".');
    expect(`${words.message} ${words.hint}`).not.toMatch(/Run extension_dev|first\.|replace: true/);
  });

  it("does not call a session on the browser asked for missing, and sends to extension_wait", () => {
    const words = sessionNotFoundWords(engine, "extension_reload", "chrome", ["chrome"]);

    expect(words.message).not.toMatch(/Run extension_dev|pass that as/);
    expect(words.message).toContain("A chrome session is recorded for this project, so this is not a missing session");
    expect(words.hint).toMatch(/^Call extension_wait with browser: "chrome", then call extension_reload again/);
  });
});

describe("974: a build receipt is never read as a dead dev session", () => {
  const engine =
    "No active control channel found for safari. Looked at /p/dist/extension-js/safari/ready.json. Run `extension dev --browser=safari --allow-eval` first.";

  it("quotes the eval start call well formed", () => {
    expect(toMcpSpeak(engine)).toBe(
      'No active control channel found for safari. Looked at /p/dist/extension-js/safari/ready.json. Run extension_dev with { browser: "safari", allowEval: true } first.',
    );

    expect(toMcpSpeak("Start a dev session first: extension dev --browser=chrome --allow-control (add --allow-eval for the eval verb)")).not.toMatch(/\(extension_dev\)/);
  });

  it("says no dev session exists and names the file as a build receipt", () => {
    const project = tmpProject();
    writeContract(project, "safari", { status: "ready", pid: 2 ** 30 }, "build");
    const receipt = path.join(project, "dist", "extension-js", "safari", "ready.json");

    const words = withSessionContext(toMcpSpeak(engine.replace("/p/dist/extension-js/safari/ready.json", receipt)), project, "extension_eval", "E_SESSION_NOT_FOUND", "safari");

    expect(words.message).toBe(
      `No dev session for safari: ${receipt} is the receipt of a finished extension_build, not a session. Run extension_dev with { browser: "safari", allowEval: true } first.`,
    );

    expect(words.message).not.toMatch(/Likely cause|dead|has exited/);
    expect(deadReadySession(project, "safari")).toBeNull();
    expect(knownSessionBrowsers(project)).toEqual([]);
  });
});
