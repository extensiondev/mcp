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

import { describe, it, expect, afterEach, vi } from "vitest";

import { writeEvalToken } from "./fixtures/ready-contract";

import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return { ...actual, runActVerb: async () => JSON.stringify({ ok: false, error: { message: "not used" } }) };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return { ...actual, resolveCdpPort: async () => ({ port: 9222, source: "contract" as const }) };
});

type Target = { id: string; type: string; url: string; title: string };
let cdpTargets: Target[] = [];
let pausedTargets = new Map<string, Record<string, unknown>>();
let frozenTargets = new Set<string>();
const pauseProbes: string[] = [];
const resumes: string[] = [];

vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdpTargets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    async connect() {}
    async attachToTarget(targetId: string) {
      return `session-${targetId}`;
    }
    async debuggerPause(sessionId: string) {
      const id = sessionId.replace(/^session-/, "");
      pauseProbes.push(id);

      return pausedTargets.get(id) ?? null;
    }
    async sendCommand(method: string, _params: Record<string, unknown> = {}, sessionId?: string, timeoutMs?: number) {
      const id = String(sessionId ?? "").replace(/^session-/, "");
      if (method === "Debugger.resume") resumes.push(id);

      if (method === "Runtime.evaluate" && frozenTargets.has(id)) {
        throw new Error(`CDP command timed out (${timeoutMs ?? 15000}ms): Runtime.evaluate`);
      }

      if (method === "Runtime.evaluate") return { result: { type: "number", value: 2 } };

      return {};
    }
    disconnect() {}
  }

  return { CDPClient };
});

const evalTool = await import("../tools/eval");

const dirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-paused-"));
  dirs.push(dir);
  const distPath = path.join(dir, "dist", "chrome");
  fs.mkdirSync(distPath, { recursive: true });
  fs.writeFileSync(path.join(distPath, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "F" }));
  const readyDir = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify({ status: "ready", distPath }));
  writeEvalToken(dir, "chrome");

  return dir;
}

const LOGIN = { id: "login", type: "page", url: "https://claude.ai/login", title: "Claude" };
const POPUP = { id: "popup", type: "page", url: "https://accounts.google.com/o/oauth2/auth", title: "Sign in" };
const PAUSE = {
  reason: "other",
  callFrames: [{ functionName: "init", url: "https://accounts.google.com/gsi/client", location: { lineNumber: 41, columnNumber: 3 } }],
};

afterEach(() => {
  cdpTargets = [];
  pausedTargets = new Map();
  frozenTargets = new Set();
  pauseProbes.length = 0;
  resumes.length = 0;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_eval on a page a debugger holds says the page is paused, by what, and what to do", () => {
  it("names the paused pop-up that freezes the page instead of a generic timeout", async () => {
    cdpTargets = [LOGIN, POPUP, { id: "dt", type: "page", url: "devtools://devtools/bundled/devtools_app.html", title: "DevTools" }];
    frozenTargets = new Set(["login"]);
    pausedTargets = new Map([["popup", PAUSE]]);

    const result = JSON.parse(
      await evalTool.handler({ projectPath: project(), targetId: "login", expression: "document.title", timeout: 6000 }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("page-paused");
    expect(result.error.code).toBe("E_PAGE_PAUSED");
    expect(result.error.message).toContain("https://claude.ai/login is alive");
    expect(result.error.message).toContain("Debugger paused in another tab");
    expect(result.error.message).toContain("targetId popup");
    expect(result.error.message).toContain("stopped at https://accounts.google.com/gsi/client:42 in init");
    expect(result.error.message).toContain("1 DevTools window is open");
    expect(result.value.paused).toMatchObject({
      targetId: "login",
      samePage: false,
      devtoolsOpen: 1,
      pausedPages: [{ targetId: "popup", url: POPUP.url, reason: "other" }],
    });

    expect(result.hint).toContain("Resume (F8)");
    expect(result.hint).toContain("close that DevTools window");
    expect(result.hint).not.toContain("went away");
    expect(pauseProbes).not.toContain("dt");
    expect(resumes).toEqual([]);
  });

  it("says the page itself is stopped when its own debugger pause holds it", async () => {
    cdpTargets = [LOGIN, POPUP];
    frozenTargets = new Set(["login"]);
    pausedTargets = new Map([["login", PAUSE]]);

    const result = JSON.parse(
      await evalTool.handler({ projectPath: project(), targetId: "login", expression: "1", timeout: 3000 }),
    );

    expect(result.status).toBe("page-paused");
    expect(result.value.paused.samePage).toBe(true);
    expect(result.error.message).toContain("its JavaScript is stopped in the debugger");
    expect(result.error.message).toContain("No DevTools window is listed");
    expect(pauseProbes).toEqual(["login"]);
  });

  it("keeps the timeout answer when no page of the browser is paused", async () => {
    cdpTargets = [LOGIN, POPUP];
    frozenTargets = new Set(["login"]);

    const result = JSON.parse(
      await evalTool.handler({ projectPath: project(), targetId: "login", expression: "1", timeout: 3000 }),
    );

    expect(result.status).toBe("eval-timeout");
    expect(result.error.code).toBe("E_CDP");
    expect(result.value?.paused).toBeUndefined();
    expect(pauseProbes.sort()).toEqual(["login", "popup"]);
  });

  it("does not probe for a pause when the evaluate answers", async () => {
    cdpTargets = [LOGIN];

    const result = JSON.parse(await evalTool.handler({ projectPath: project(), targetId: "login", expression: "1+1" }));

    expect(result.ok).toBe(true);
    expect(result.value).toBe(2);
    expect(pauseProbes).toEqual([]);
  });
});
