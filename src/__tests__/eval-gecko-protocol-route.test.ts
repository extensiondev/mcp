import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import { envelope } from "../lib/envelope";
import { actVerbAnswer, evalRefusal } from "./fixtures/engine-answers";

import type { RdpTab } from "../lib/rdp";
import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";
import type * as RdpModule from "../lib/rdp";

type Call = { cli: string[]; expression: string };
const calls: Call[] = [];
let respond: (call: Call, index: number) => string = () =>
  envelope({ ok: true, command: "extension_eval", status: "ok", value: 1 });

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

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
  const actual = await importOriginal<typeof CdpPortModule>();

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
let listRefused = false;

vi.mock("../lib/rdp", async (importOriginal) => {
  const actual = await importOriginal<typeof RdpModule>();

  return {
    ...actual,
    rdpListTabs: async () => {
      if (listRefused) throw new Error("connect ECONNREFUSED 127.0.0.1:9222");

      return openTabs;
    },
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

const refusedByCsp = (name = "EvalError") =>
  actVerbAnswer(
    evalRefusal({
      code: "E_CSP_BLOCKS_EVAL",
      name,
      message: "call to eval() blocked by CSP",
      engine: "firefox",
      hint: "The extension's own content_security_policy forbids eval in this document, so no expression runs there, 1 + 1 included.",
    }),
    "extension_eval",
  );

const olderEngineRefusal = () =>
  actVerbAnswer(
    evalRefusal({
      code: "E_EVAL",
      name: "EvalError",
      message: "call to eval() blocked by CSP",
      engine: "firefox",
      hint: "The expression threw inside the page. Check the expression itself.",
    }),
    "extension_eval",
  );

const value = (v: unknown) =>
  envelope({ ok: true, command: "extension_eval", status: "ok", value: v });

const contextOf = (cli: string[]) => cli[cli.indexOf("--context") + 1];

afterEach(() => {
  calls.length = 0;
  rdpCalls.length = 0;
  openTabs = [];
  rdpPort = 9222;
  rdpAnswer = () => ({ ok: true, value: "over-protocol" });
  listRefused = false;
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
        : actVerbAnswer(
            evalRefusal({ code: "E_EVAL", name: "EvalError", message: "nope is not defined", engine: "firefox" }),
            "extension_eval",
          );

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
    expect(result.error.retry).toBe("safe");
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
    expect(result.warnings.join("\n")).toMatch(/Evaluated in the tab showing http:\/\/127\.0\.0\.1:8765\/csp\.html \("csp host"\)/);
  });

  it("says when several tabs matched the url and one was picked", async () => {
    const dir = project(MV3);
    respond = () => refusedByCsp();
    openTabs = [
      { actor: "tab1", url: "http://127.0.0.1:8765/csp.html", title: "one" },
      { actor: "tab2", url: "http://127.0.0.1:8765/csp.html", title: "two" },
    ];

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "http://127.0.0.1:8765/csp.html", expression: "1" }),
    );
    expect(result.warnings.join("\n")).toMatch(/2 open tabs show http:\/\/127\.0\.0\.1:8765\/csp\.html; this used targetId tab1/);
  });

  it("names a document that went away mid-call and one the protocol could not reach", async () => {
    const dir = project(MV3);
    respond = () => refusedByCsp();
    openTabs = [{ actor: "tab2", url: "http://127.0.0.1:8765/csp.html", title: "csp host" }];
    rdpAnswer = () => ({ ok: false, name: "EvalLost", message: "the document went away" });
    const lost = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "http://127.0.0.1:8765/csp.html", expression: "1" }),
    );
    expect(lost.status).toBe("eval-lost");
    expect(lost.hint).toMatch(/may have run in part/);
    expect(lost.error.retry).toBe("after-read");
    rdpAnswer = () => ({ ok: false, name: "Unsupported", message: "no console actor" });
    const unsupported = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "http://127.0.0.1:8765/csp.html", expression: "1" }),
    );
    expect(unsupported.status).toBe("eval-unsupported");
    expect(unsupported.hint).toMatch(/never ran/);
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

const refusedHostAccess = () =>
  envelope({
    ok: false,
    command: "extension_eval",
    status: "page-not-scriptable",
    error: {
      code: "E_PAGE_NOT_SCRIPTABLE",
      cliCode: "E_COMMAND_UNSUPPORTED_FOR_TARGET",
      name: "InjectionRefused",
      message: "Missing host permission for the tab",
      engine: "firefox",
    },
    hint: "The tab is open, but firefox refused to script it, so nothing ran there.",
  });

describe("985: a web page the extension holds no host access to", () => {
  it("is evaluated over the debugger protocol in the tab the url names, as Chromium reads it over CDP", async () => {
    const dir = project({ ...MV3, permissions: ["activeTab"] });
    respond = () => refusedHostAccess();
    openTabs = [
      { actor: "tab1", url: "about:addons", title: "Add-ons", selected: true },
      { actor: "tab2", url: "http://127.0.0.1:4173/note.html", title: "Note" },
    ];

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "http://127.0.0.1:4173/note.html", expression: "document.title" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("over-protocol");
    expect(rdpCalls).toHaveLength(1);
    expect(rdpCalls[0].picked?.actor).toBe("tab2");
    expect(rdpCalls[0].expression).toBe("document.title");
    expect(result.warnings.join("\n")).toMatch(/no host access to http:\/\/127\.0\.0\.1:4173\/note\.html/);
  });

  it("keeps the refusal for a privileged about: page, which no route may script", async () => {
    const dir = project(MV3);
    respond = () => refusedHostAccess();
    openTabs = [{ actor: "tab1", url: "about:addons", title: "Add-ons", selected: true }];

    for (const url of ["about:addons", undefined]) {
      const result = JSON.parse(
        await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url, expression: "document.title" }),
      );

      expect(result.error.code, String(url)).toBe("E_PAGE_NOT_SCRIPTABLE");
    }

    expect(rdpCalls.every((call) => call.picked === undefined)).toBe(true);
  });

  it("1043: keeps the not-scriptable refusal for a statement list when no web tab would be evaluated", async () => {
    const dir = project(MV3);
    respond = () => refusedHostAccess();
    openTabs = [{ actor: "tab1", url: "about:addons", title: "Add-ons", selected: true }];

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", expression: "const a = 1; a" }),
    );

    expect(result.error.code).toBe("E_PAGE_NOT_SCRIPTABLE");
    expect(rdpCalls).toHaveLength(0);
  });

  it("1045: refuses a url that two different web pages contain, as the extension-page route does", async () => {
    const dir = project(MV3);
    respond = () => refusedHostAccess();
    openTabs = [
      { actor: "tab1", url: "http://127.0.0.1:4173/note.html", title: "Note" },
      { actor: "tab2", url: "https://bank.example/notes/transfer", title: "Bank", selected: true },
    ];

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "note", expression: "document.title" }),
    );

    expect(result.error.code).toBe("E_AMBIGUOUS_TARGET");
    expect(result.value.matchingUrls).toEqual(expect.arrayContaining(["http://127.0.0.1:4173/note.html", "https://bank.example/notes/transfer"]));
    expect(rdpCalls).toHaveLength(0);
  });

  it("1045: evaluates one of two tabs that show the same page, since nothing is ambiguous", async () => {
    const dir = project(MV3);
    respond = () => refusedHostAccess();
    openTabs = [
      { actor: "tab1", url: "http://127.0.0.1:4173/note.html", title: "one" },
      { actor: "tab2", url: "http://127.0.0.1:4173/note.html", title: "two", selected: true },
    ];

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "note", expression: "document.title" }),
    );

    expect(result.ok).toBe(true);
    expect(rdpCalls).toHaveLength(1);
  });

  it("1045: claims a debugger-protocol read only when the read happened", async () => {
    const dir = project(MV3);
    respond = () => refusedHostAccess();
    openTabs = [{ actor: "tab1", url: "http://127.0.0.1:4173/note.html", title: "Note", selected: true }];

    rdpAnswer = () => {
      throw new Error("socket hang up");
    };

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "http://127.0.0.1:4173/note.html", expression: "document.title" }),
    );

    expect(result.status).toBe("rdp-failed");
    expect((result.warnings ?? []).join("\n")).not.toMatch(/went over the debugger protocol/);

    listRefused = true;
    const dead = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "http://127.0.0.1:4173/note.html", expression: "document.title" }),
    );

    expect(dead.status).toBe("rdp-failed");
    expect(dead.error).toMatchObject({ code: "E_RDP", retry: "safe" });
  });

  it("keeps a refusal that names no missing host access, since only that one is a debug read away", async () => {
    const dir = project(MV3);
    respond = () =>
      envelope({
        ok: false,
        command: "extension_eval",
        status: "page-not-scriptable",
        error: { code: "E_PAGE_NOT_SCRIPTABLE", name: "InjectionRefused", message: "The page cannot be scripted in reader view", engine: "firefox" },
        hint: "The tab is open, but firefox refused to script it, so nothing ran there.",
      });

    openTabs = [{ actor: "tab1", url: "https://example.com/story", title: "Story", selected: true }];

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "https://example.com/story", expression: "document.title" }),
    );

    expect(result.error.code).toBe("E_PAGE_NOT_SCRIPTABLE");
    expect(rdpCalls).toHaveLength(0);
  });

  it("keeps the refusal when the session publishes no debugger port, and the hint never asks to widen the manifest", async () => {
    const dir = project(MV3);
    rdpPort = null;
    respond = () => refusedHostAccess();

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "http://127.0.0.1:4173/note.html", expression: "document.title" }),
    );

    expect(result.error.code).toBe("E_PAGE_NOT_SCRIPTABLE");
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
