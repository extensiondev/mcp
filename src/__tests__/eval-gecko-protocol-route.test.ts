import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelope } from "../lib/envelope";
import type { RdpTab } from "../lib/rdp";

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

let rdpPort: number | null = 9222;
vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return {
    ...actual,
    resolveCdpPort: async () => null,
    resolveRdpPort: async () =>
      rdpPort === null ? null : { port: rdpPort, source: "contract" as const },
  };
});

type RdpCall = { port: number; expression: string; picked: RdpTab | null | undefined };
const rdpCalls: RdpCall[] = [];
let openTabs: RdpTab[] = [];
let rdpAnswer: (picked: RdpTab) => unknown = () => ({ ok: true, value: "over-protocol" });

vi.mock("../lib/rdp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/rdp")>();
  return {
    ...actual,
    rdpEvaluateInTab: async (
      port: number,
      options: { select: (tabs: RdpTab[]) => RdpTab | null | undefined; expression: string },
    ) => {
      const picked = options.select(openTabs);
      rdpCalls.push({ port, expression: options.expression, picked });
      if (!picked) return { ok: false, name: "TargetNotFound", message: "no open tab matches" };
      const answer = rdpAnswer(picked) as Record<string, unknown>;
      return answer.ok === true
        ? { ...answer, tab: { url: String(picked.url), title: String(picked.title ?? "") } }
        : answer;
    },
  };
});

const evalTool = await import("../tools/eval");

const dirs: string[] = [];
function project(manifest: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-gecko-route-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", "firefox");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

const MV3 = {
  manifest_version: 3,
  name: "Strict",
  action: { default_popup: "action/index.html" },
  options_ui: { page: "options/index.html" },
  background: { scripts: ["bg.js"] },
};
const MV2 = { manifest_version: 2, name: "F", background: { scripts: ["bg.js"] } };

const BASE = "moz-extension://1e5c8097-57a9-4052-bd54-d5d37a7086de/";

/* @invariant What Extension.js 4.1.31 answers when the document's policy stops the eval
   it was asked to run: the code is its own from that release on, where older
   engines said E_EVAL with the same message. */
const refusedByCsp = (name = "EvalError") =>
  envelope({
    ok: false,
    command: "extension_eval",
    status: "denied",
    error: {
      code: "E_CSP_BLOCKS_EVAL",
      name,
      message: "call to eval() blocked by CSP",
      engine: "firefox",
      hint: "The extension's own content_security_policy forbids eval in this document, so no expression runs there, 1 + 1 included.",
    },
  });

const olderEngineRefusal = () =>
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

const value = (v: unknown) =>
  envelope({ ok: true, command: "extension_eval", status: "ok", value: v });

const contextOf = (cli: string[]) => cli[cli.indexOf("--context") + 1];

afterEach(() => {
  calls.length = 0;
  rdpCalls.length = 0;
  openTabs = [];
  rdpPort = 9222;
  rdpAnswer = () => ({ ok: true, value: "over-protocol" });
  respond = () => value(1);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("a Gecko surface whose policy forbids eval is evaluated without the relay wrapper", () => {
  it("sends the bare expression once the wrapper is refused, so the engine can take it over the protocol", async () => {
    const dir = project(MV3);
    respond = (call) =>
      call.expression.includes("(0, eval)") ? refusedByCsp() : value("popup page");

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "popup",
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("popup page");
    expect(calls).toHaveLength(2);
    expect(calls[1].expression).toBe("document.title");
    expect(contextOf(calls[1].cli)).toBe("popup");
  });

  it("hands back the expression's own error from the second run, not the policy refusal", async () => {
    const dir = project(MV3);
    respond = (call) =>
      call.expression.includes("(0, eval)")
        ? refusedByCsp()
        : envelope({
            ok: false,
            command: "extension_eval",
            status: "failed",
            error: { code: "E_EVAL", name: "EvalError", message: "nope is not defined" },
          });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "options",
        expression: "nope.nope",
      }),
    );

    expect(result.error.message).toBe("nope is not defined");
    expect(result.error.name).not.toBe("CspBlocksEval");
  });

  it("names the engine floor when the session's engine refuses the bare expression too", async () => {
    const dir = project(MV3);
    respond = () => olderEngineRefusal();

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "popup",
        expression: "1 + 1",
      }),
    );

    expect(calls).toHaveLength(2);
    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("CspBlocksEval");
    expect(result.hint).toContain("4.1.31");
    expect(JSON.stringify(result)).not.toContain("Check the expression itself");
  });

  it("refuses a statement list by name instead of sending it on to fail as a syntax error", async () => {
    const dir = project(MV3);
    respond = () => refusedByCsp();

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "popup",
        expression: "var a = 1; a",
      }),
    );

    expect(calls).toHaveLength(1);
    expect(result.error.code).toBe("E_BAD_REQUEST");
    expect(result.error.name).toBe("NotOneExpression");
    expect(result.hint).toContain("one expression");
  });

  it("keeps the wrapper's answer on a surface whose policy allows eval", async () => {
    const dir = project(MV3);
    respond = () => value({ __extensionDevRelay: 1, done: true, ok: true, value: "allowed" });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "popup",
        expression: "document.title",
      }),
    );

    expect(calls).toHaveLength(1);
    expect(result.value).toBe("allowed");
  });
});

describe("a page inside the extension that the manifest declares as no surface", () => {
  it("is evaluated over the debugger protocol in the tab that shows it", async () => {
    const dir = project(MV3);
    const url = `${BASE}pages/panel.html`;
    openTabs = [
      { actor: "tab1", url: `${BASE}action/index.html`, title: "popup" },
      { actor: "tab2", url: `${url}?from=test#top`, title: "panel" },
    ];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url,
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("over-protocol");
    expect(rdpCalls).toHaveLength(1);
    expect(rdpCalls[0].picked?.actor).toBe("tab2");
    expect(rdpCalls[0].expression).toBe("document.title");
    expect(calls).toHaveLength(0);
  });

  it("says the page is not open when no tab shows it", async () => {
    const dir = project(MV3);
    openTabs = [{ actor: "tab1", url: "https://example.com/", title: "Example" }];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: `${BASE}pages/panel.html`,
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NO_MATCHING_TARGET");
    expect(result.hint).toContain("extension_open");
  });

  it("carries the expression's own throw with its name", async () => {
    const dir = project(MV3);
    const url = `${BASE}pages/panel.html`;
    openTabs = [{ actor: "tab2", url, title: "panel" }];
    rdpAnswer = () => ({ ok: false, name: "ReferenceError", message: "nope is not defined" });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url,
        expression: "nope.nope",
      }),
    );

    expect(result.error).toMatchObject({
      code: "E_EVAL",
      name: "ReferenceError",
      message: "nope is not defined",
    });
  });

  it("says the debugger port did not answer instead of 'matches none of the surface documents'", async () => {
    const dir = project(MV3);
    openTabs = [{ actor: "tab1", url: `${BASE}pages/panel.html`, title: "Panel" } as RdpTab];
    rdpAnswer = () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9222");
    };

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: `${BASE}pages/panel.html`,
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("rdp-failed");
    expect(result.error.code).toBe("E_RDP");
    expect(result.error.message).toContain("ECONNREFUSED");
    expect(result.error.message).not.toContain("matches none");
  });

  it("keeps the no-surface answer when the session publishes no debugger port", async () => {
    const dir = project(MV3);
    rdpPort = null;

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: `${BASE}pages/panel.html`,
        expression: "document.title",
      }),
    );

    expect(result.error.code).toBe("E_NO_SURFACE_DOCUMENT");
    expect(rdpCalls).toHaveLength(0);
  });
});

describe("a web page whose own policy forbids eval, on a Gecko build with no tabs.executeScript", () => {
  it("is evaluated over the debugger protocol in the tab the url names", async () => {
    const dir = project(MV3);
    respond = () => refusedByCsp();
    openTabs = [
      { actor: "tab1", url: "http://127.0.0.1:8765/index.html", title: "host" },
      { actor: "tab2", url: "http://127.0.0.1:8765/csp.html", title: "csp host" },
    ];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "http://127.0.0.1/csp.html",
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("over-protocol");
    expect(rdpCalls[0].picked?.actor).toBe("tab2");
  });

  it("explains the page's policy, not the extension's, when only a tab id names the page", async () => {
    const dir = project(MV3);
    respond = () => refusedByCsp();

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        tab: 4,
        expression: "document.title",
      }),
    );

    expect(rdpCalls).toHaveLength(0);
    expect(result.error.name).toBe("CspBlocksEval");
    expect(result.hint).toContain("page's own Content-Security-Policy");
    expect(result.hint).toContain("Pass url");
    expect(JSON.stringify(result)).not.toContain("extension's own content_security_policy");
  });

  it("still takes tabs.executeScript on an MV2 build now that the engine names the refusal itself", async () => {
    const dir = project(MV2);
    respond = (call, index) =>
      index === 0
        ? refusedByCsp()
        : value({ frames: [{ __extensionDevExec: 1, ok: true, value: "520K" }] });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "https://www.youtube.com/*",
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("520K");
    expect(contextOf(calls[1].cli)).toBe("background");
    expect(calls[1].expression).toContain("executeScript");
    expect(rdpCalls).toHaveLength(0);
  });
});

describe("the refusals that stay refusals read true", () => {
  it("names the content-script world when the extension's policy stops a content eval", async () => {
    const dir = project(MV3);
    respond = () => refusedByCsp("Unsupported");

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "content",
        url: "http://127.0.0.1/index.html",
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_CSP_BLOCKS_EVAL");
    expect(result.error.name).toBe("CspBlocksEval");
    expect(result.hint).toContain("content-script world");
    expect(rdpCalls).toHaveLength(0);
  });

  it("names a statement list sent to a policy-locked background instead of a control-channel failure", async () => {
    const dir = project(MV3);
    respond = () =>
      envelope({
        ok: false,
        command: "extension_eval",
        status: "failed",
        error: {
          code: "E_CONTROL_UNAVAILABLE",
          name: "Unavailable",
          message: "SyntaxError: expected expression, got keyword 'var'",
          engine: "firefox",
        },
      });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "background",
        expression: "var a = 20; a + 1",
      }),
    );

    expect(result.error.name).toBe("NotOneExpression");
    expect(result.error.code).toBe("E_BAD_REQUEST");
  });

  it("leaves a real control-channel failure alone", async () => {
    const dir = project(MV3);
    respond = () =>
      envelope({
        ok: false,
        command: "extension_eval",
        status: "failed",
        error: {
          code: "E_CONTROL_UNAVAILABLE",
          name: "Unavailable",
          message: "no executor connected",
          engine: "firefox",
        },
      });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "background",
        expression: "var a = 20; a + 1",
      }),
    );

    expect(result.error.code).toBe("E_CONTROL_UNAVAILABLE");
  });
});
