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

import { readyContract } from "./fixtures/engine-answers";

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

let cdpTargets: Array<{ id: string; type: string; url: string; title?: string }> = [];
const commands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
let refuse = new Set<string>();
let shown = new Set<string>();

vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdpTargets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    async connect() {}
    async attachToTarget(id: string) {
      return `session-${id}`;
    }
    async enableDomains() {}
    async navigate() {}
    async evaluate(sessionId: string) {
      const id = sessionId.replace(/^session-/, "");

      return { visibilityState: shown.has(id) ? "visible" : "hidden", width: 1280, height: 800 };
    }
    async sendCommand(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
      commands.push({ method, params, sessionId });
      if (refuse.has(method)) throw new Error(`${method} is not allowed`);

      if (method === "Target.createTarget") {
        cdpTargets = [...cdpTargets, { id: "created", type: "page", url: String(params.url ?? "") }];
        if (params.background === false) shown.add("created");

        return { targetId: "created" };
      }

      if (method === "Target.activateTarget") shown.add(String(params.targetId));
      if (method === "Page.bringToFront") shown.add(String(sessionId).replace(/^session-/, ""));

      return {};
    }
    disconnect() {}
  }

  return { CDPClient };
});

const open = await import("../tools/open");

const dirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-foreground-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "F" }));
  const readyDir = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(
    path.join(readyDir, "ready.json"),
    JSON.stringify(readyContract("dev", "chrome", { distPath: path.join(dir, "dist", "chrome") })),
  );

  return dir;
}

const SIGN_IN = "https://accounts.google.com/ServiceLogin?continue=https://mail.google.com/mail/";

function sent(method: string) {
  return commands.filter((c) => c.method === method);
}

afterEach(() => {
  cdpTargets = [];
  commands.length = 0;
  refuse = new Set();
  shown = new Set();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_open foreground: true brings a page the person must act on forward, and only then", () => {
  it("opens the tab active, raises its window, and says so in a headed session", async () => {
    vi.stubEnv("EXTENSION_HEADLESS", "0");
    vi.stubEnv("EXTENSION_BROWSER_FLAGS", "");

    const result = JSON.parse(await open.handler({ projectPath: project(), url: SIGN_IN, foreground: true }));

    expect(result.ok).toBe(true);
    expect(sent("Target.createTarget")[0].params.background).toBe(false);
    expect(sent("Target.activateTarget").map((c) => c.params.targetId)).toEqual(["created"]);
    expect(sent("Page.bringToFront").map((c) => c.sessionId)).toEqual(["session-created"]);
    expect(result.value.foreground).toEqual({ requested: true, activated: true, windowRaised: true });
    expect(result.value.tab).toEqual({ active: true, visibilityState: "visible" });
    expect(result.hint).toContain("brought forward as asked");
    expect(result.hint).toContain("Tell them it is waiting for them");
  });

  it("keeps the default a background tab that never activates or raises anything", async () => {
    vi.stubEnv("EXTENSION_HEADLESS", "0");
    vi.stubEnv("EXTENSION_BROWSER_FLAGS", "");

    const result = JSON.parse(await open.handler({ projectPath: project(), url: SIGN_IN }));

    expect(result.ok).toBe(true);
    expect(sent("Target.createTarget")[0].params.background).toBe(true);
    expect(sent("Target.activateTarget")).toEqual([]);
    expect(sent("Page.bringToFront")).toEqual([]);
    expect(result.value).not.toHaveProperty("foreground");
    expect(result.value.tab).toEqual({ active: false, visibilityState: "hidden" });
  });

  it("brings forward a reused blank tab the navigation landed in", async () => {
    vi.stubEnv("EXTENSION_HEADLESS", "0");
    vi.stubEnv("EXTENSION_BROWSER_FLAGS", "");
    cdpTargets = [{ id: "blank", type: "page", url: "about:blank" }];

    const result = JSON.parse(await open.handler({ projectPath: project(), url: "about:blank", foreground: true }));

    expect(result.value.target.targetId).toBe("blank");
    expect(sent("Target.activateTarget").map((c) => c.params.targetId)).toEqual(["blank"]);
    expect(result.value.foreground.windowRaised).toBe(true);
  });

  it("says the window was not raised when the browser refuses Page.bringToFront", async () => {
    vi.stubEnv("EXTENSION_HEADLESS", "0");
    vi.stubEnv("EXTENSION_BROWSER_FLAGS", "");
    refuse = new Set(["Page.bringToFront"]);

    const result = JSON.parse(await open.handler({ projectPath: project(), url: SIGN_IN, foreground: true }));

    expect(result.value.foreground).toMatchObject({ activated: true, windowRaised: false });
    expect(result.value.foreground.reason).toContain("Page.bringToFront refused");
    expect(result.hint).toContain("the window was not raised");
  });

  it("warns that nothing came forward when both commands are refused", async () => {
    vi.stubEnv("EXTENSION_HEADLESS", "0");
    vi.stubEnv("EXTENSION_BROWSER_FLAGS", "");
    refuse = new Set(["Page.bringToFront", "Target.activateTarget"]);

    const result = JSON.parse(await open.handler({ projectPath: project(), url: SIGN_IN, foreground: true }));

    expect(result.ok).toBe(true);
    expect(result.value.foreground).toMatchObject({ activated: false, windowRaised: false });
    expect(result.warnings.join(" ")).toContain("NOT brought forward");
  });

  it("says no one can see the tab in a headless session", async () => {
    vi.stubEnv("EXTENSION_HEADLESS", "1");

    const result = JSON.parse(await open.handler({ projectPath: project(), url: SIGN_IN, foreground: true }));

    expect(result.value.foreground.activated).toBe(true);
    expect(result.hint).toContain("this session is headless, so no one can see it");
    expect(result.hint).toContain("headless: false and replace: true");
  });

  it("describes the option as opt-in for a person's action, with background as the default", () => {
    const described = (open.schema.inputSchema.properties as Record<string, { description: string; default?: unknown }>).foreground;

    expect(described.default).toBe(false);
    expect(described.description).toContain("must act on");
    expect(described.description).toContain("never for pages only the agent reads");
    expect(open.schema.description).toContain("opens in a background tab unless foreground: true");
  });
});
