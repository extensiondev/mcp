import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelope } from "../lib/envelope";

type Call = { cli: string[]; expression: string };
const calls: Call[] = [];
let respond: (call: Call, index: number) => string = () =>
  envelope({ ok: true, command: "extension_eval", status: "ok", value: 1 });

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      const at = cli.indexOf("--");
      const call = { cli, expression: at === -1 ? "" : cli[at + 1] };
      calls.push(call);
      return respond(call, calls.length - 1);
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return { ...actual, resolveCdpPort: async () => null };
});

const evalTool = await import("../tools/eval");

const dirs: string[] = [];
function project(manifest: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-gecko-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", "firefox");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

const MV2 = { manifest_version: 2, name: "F", background: { scripts: ["bg.js"] } };

const contextOf = (cli: string[]) => cli[cli.indexOf("--context") + 1];

const noScripting = () =>
  envelope({
    ok: false,
    command: "extension_eval",
    status: "failed",
    error: {
      code: "E_NOT_IMPLEMENTED",
      name: "Unsupported",
      message:
        'chrome.scripting is not available on this engine (MV2 has no scripting API); use context: "background"',
    },
  });

afterEach(() => {
  calls.length = 0;
  respond = () => envelope({ ok: true, command: "extension_eval", status: "ok", value: 1 });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_eval names the extension's CSP instead of blaming the expression", () => {
  it("rewrites the eval-blocked refusal with the policy and the paths around it", async () => {
    const dir = project({ ...MV2, manifest_version: 3 });
    respond = () =>
      envelope({
        ok: false,
        command: "extension_eval",
        status: "failed",
        error: {
          code: "E_EVAL",
          name: "EvalError",
          message: "call to eval() blocked by CSP",
          engine: "firefox",
          hint: "The expression threw inside the page. Check the expression itself.",
        },
      });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "background",
        expression: "1 + 1",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_EVAL");
    expect(result.error.name).toBe("CspBlocksEval");
    expect(result.hint).toContain("content_security_policy");
    expect(result.hint).toContain("not a fault in the expression");
    expect(JSON.stringify(result)).not.toContain("Check the expression itself");
  });

  it("leaves a genuine expression error alone", async () => {
    const dir = project(MV2);
    respond = () =>
      envelope({
        ok: false,
        command: "extension_eval",
        status: "failed",
        error: { code: "E_EVAL", name: "ReferenceError", message: "nope is not defined" },
      });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "background",
        expression: "nope",
      }),
    );

    expect(result.error.name).toBe("ReferenceError");
    expect(result.hint ?? "").not.toContain("content_security_policy");
  });
});

describe("extension_eval on MV2 Gecko reaches a tab through tabs.executeScript", () => {
  it("retries a page eval from the background with the executeScript wrapper and unwraps the result", async () => {
    const dir = project(MV2);
    respond = (call, index) =>
      index === 0
        ? noScripting()
        : envelope({
            ok: true,
            command: "extension_eval",
            status: "ok",
            value: { frames: [{ __extensionDevExec: 1, ok: true, value: "Example Domain" }] },
          });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "https://example.com/",
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("Example Domain");
    expect(calls).toHaveLength(2);
    expect(contextOf(calls[0].cli)).toBe("page");
    expect(contextOf(calls[1].cli)).toBe("background");
    expect(calls[1].cli).not.toContain("--url");
    expect(calls[1].expression).toContain("browser.tabs.executeScript");
    expect(calls[1].expression).toContain('"https://example.com/"');
    expect(calls[1].expression).toContain("document.title");
    expect(result.warnings[0]).toContain("tabs.executeScript");
    expect(result.warnings[0]).toContain("MAIN world");
  });

  it("retries a page eval the PAGE's CSP refused through executeScript on an MV2 build", async () => {
    const dir = project(MV2);
    respond = (call, index) =>
      index === 0
        ? envelope({
            ok: false,
            command: "extension_eval",
            status: "failed",
            error: { code: "E_EVAL", name: "EvalError", message: "call to eval() blocked by CSP", engine: "firefox" },
          })
        : envelope({
            ok: true,
            command: "extension_eval",
            status: "ok",
            value: { frames: [{ __extensionDevExec: 1, ok: true, value: 3 }] },
          });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "https://www.youtube.com/watch?v=x",
        expression: "document.querySelectorAll('.playerButton').length",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe(3);
    expect(calls).toHaveLength(2);
    expect(contextOf(calls[1].cli)).toBe("background");
    expect(calls[1].expression).toContain("browser.tabs.executeScript");
    expect(result.warnings[0]).toContain("content security policy refused the in-page eval");
  });

  it("keeps the CSP explanation on an MV3 Gecko build, which has no tabs.executeScript", async () => {
    const dir = project({ manifest_version: 3, name: "F", background: { scripts: ["bg.js"] } });
    respond = () =>
      envelope({
        ok: false,
        command: "extension_eval",
        status: "failed",
        error: { code: "E_EVAL", name: "EvalError", message: "call to eval() blocked by CSP", engine: "firefox" },
      });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "https://www.youtube.com/watch?v=x",
        expression: "1",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("CspBlocksEval");
    expect(calls).toHaveLength(1);
  });

  it("reports a throw inside the tab as E_EVAL", async () => {
    const dir = project(MV2);
    respond = (_call, index) =>
      index === 0
        ? noScripting()
        : envelope({
            ok: true,
            command: "extension_eval",
            status: "ok",
            value: {
              frames: [{ __extensionDevExec: 1, ok: false, name: "TypeError", message: "x is null" }],
            },
          });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "content",
        expression: "x.y",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_EVAL");
    expect(result.error.name).toBe("TypeError");
    expect(result.error.message).toBe("x is null");
  });

  it("passes a statement list through as the script itself", async () => {
    const dir = project(MV2);
    respond = (_call, index) =>
      index === 0
        ? noScripting()
        : envelope({
            ok: true,
            command: "extension_eval",
            status: "ok",
            value: { frames: [42] },
          });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        expression: "var a = 40; a + 2",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
    expect(calls[1].expression).toContain("var a = 40; a + 2");
    expect(calls[1].expression).not.toContain("__extensionDevExec");
  });

  it("names the executeScript refusal when the tab cannot be injected", async () => {
    const dir = project(MV2);
    respond = (_call, index) =>
      index === 0
        ? noScripting()
        : envelope({
            ok: true,
            command: "extension_eval",
            status: "ok",
            value: { error: "Missing host permission for the tab" },
          });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "https://private.example/",
        expression: "1",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.message).toBe("Missing host permission for the tab");
    expect(result.hint).toContain("host permissions");
  });

  it("does not retry on Chromium or for a different refusal", async () => {
    const dir = project(MV2);
    respond = () =>
      envelope({
        ok: false,
        command: "extension_eval",
        status: "no-session",
        error: { code: "E_NO_SESSION", name: "NoSession", message: "no session" },
      });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        expression: "1",
      }),
    );

    expect(result.error.code).toBe("E_NO_SESSION");
    expect(calls).toHaveLength(1);
  });
});
