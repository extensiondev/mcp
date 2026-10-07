// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, it, expect, vi, beforeEach } from "vitest";
import { actFrame } from "./fixtures/engine-answers";

const act = vi.hoisted(() => ({
  calls: [] as Array<{ cli: string[]; projectPath: string; timeout: number | undefined; tool: string | undefined }>,
  reply: "" as string,
}));
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[], projectPath: string, timeout?: number, tool?: string) => {
      act.calls.push({ cli, projectPath, timeout, tool });
      return act.reply;
    },
  };
});

const session = vi.hoisted(() => ({ browser: "chrome", asked: [] as Array<string | undefined> }));
vi.mock("../lib/session-browser", () => ({
  resolveSessionBrowser: (_projectPath: string, explicit: string | undefined) => {
    session.asked.push(explicit);
    return { browser: explicit ?? session.browser, source: explicit ? "explicit" : "session" };
  },
}));

const reload = await import("../tools/reload");

beforeEach(() => {
  act.calls.length = 0;
  act.reply = JSON.stringify(actFrame("reload", { reloaded: "background" }));
  session.browser = "chrome";
  session.asked.length = 0;
});

describe("extension_reload hands the reload verb to the engine as it was asked", () => {
  it("is registered as extension_reload and names the control channel it needs", () => {
    expect(reload.schema.name).toBe("extension_reload");
    expect(reload.schema.description).toContain("allowControl");
    expect(reload.schema.inputSchema.required).toEqual(["projectPath"]);
    expect((reload.schema.inputSchema.properties.context as { default: string }).default).toBe("background");
  });

  it("reloads the background by default, on the session's own browser, and returns the engine's frame unchanged", async () => {
    session.browser = "firefox";

    const out = await reload.handler({ projectPath: "/p" });

    expect(out).toBe(act.reply);
    expect(act.calls).toHaveLength(1);
    expect(act.calls[0].cli).toEqual(["reload", "/p", "--browser", "firefox"]);
    expect(act.calls[0].projectPath).toBe("/p");
    expect(act.calls[0].timeout).toBeUndefined();
    expect(act.calls[0].tool).toBe("extension_reload");
    expect(session.asked).toEqual([undefined]);
  });

  it("passes context, tab, an explicit browser and the timeout through commonFlags", async () => {
    const out = await reload.handler({
      projectPath: "/p",
      context: "content",
      tab: 7,
      browser: "edge",
      timeout: 1500,
    });

    expect(out).toBe(act.reply);
    expect(act.calls[0].cli).toEqual([
      "reload",
      "/p",
      "--context",
      "content",
      "--tab",
      "7",
      "--browser",
      "edge",
      "--timeout",
      "1500",
    ]);
    expect(act.calls[0].timeout).toBe(1500);
    expect(session.asked).toEqual(["edge"]);
  });

  it("returns a refusal from the engine as it came, without rewording it", async () => {
    act.reply = JSON.stringify({
      ok: false,
      command: "extension_reload",
      status: "failed",
      value: null,
      error: { code: "E_SESSION_NOT_FOUND", name: "CliError", message: "No active control channel found for chrome." },
      warnings: [],
    });

    const out = await reload.handler({ projectPath: "/p", context: "page", tab: 2 });

    expect(out).toBe(act.reply);
    expect(act.calls[0].cli).toEqual(["reload", "/p", "--context", "page", "--tab", "2", "--browser", "chrome"]);
  });
});
