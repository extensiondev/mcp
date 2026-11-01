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

vi.mock("../lib/rdp", async (importOriginal) => {
  const actual = await importOriginal<typeof RdpModule>();

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-gecko-await-"));
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

const value = (v: unknown) =>
  envelope({ ok: true, command: "extension_eval", status: "ok", value: v });

afterEach(() => {
  calls.length = 0;
  rdpCalls.length = 0;
  openTabs = [];
  rdpPort = 9222;
  rdpAnswer = () => ({ ok: true, value: "over-protocol" });
  respond = () => value(1);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});


const AWAITING = "({ gpu: true, adapter: await Promise.resolve(7).then((a) => !!a) })";

async function runInDocument(expression: string): Promise<unknown> {
  return await new Function(`return (${expression}\n)`)();
}

describe("an expression that awaits at top level, on a Gecko route that takes one expression", () => {
  it("runs in the page's tab over the debugger protocol wrapped in an async function", async () => {
    const dir = project(MV3);
    respond = () => refusedByCsp();
    openTabs = [{ actor: "tab2", url: "https://www.youtube.com/watch?v=1", title: "watch" }];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "https://www.youtube.com/watch",
        expression: AWAITING,
      }),
    );

    expect(result.ok).toBe(true);
    expect(rdpCalls).toHaveLength(1);
    expect(rdpCalls[0].expression).toMatch(/^\(async \(\) => \(/);
    await expect(runInDocument(rdpCalls[0].expression)).resolves.toEqual({ gpu: true, adapter: true });
  });

  it("goes to the engine's protocol route wrapped on a surface whose policy forbids eval", async () => {
    const dir = project(MV3);
    respond = (_call, index) => (index === 0 ? refusedByCsp() : value({ adapter: true }));

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "popup", expression: AWAITING }),
    );

    expect(calls).toHaveLength(2);
    expect(result.ok).toBe(true);
    await expect(runInDocument(calls[1].expression)).resolves.toEqual({ gpu: true, adapter: true });
  });

  it("hands the background route the expression wrapped, so the engine awaits it instead of failing to parse it", async () => {
    const dir = project(MV3);
    respond = () => value({ gpu: true, adapter: true });

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "background", expression: AWAITING }),
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    await expect(runInDocument(calls[0].expression)).resolves.toEqual({ gpu: true, adapter: true });
  });

  it("hands the in-page relay the expression wrapped, so its indirect eval parses it", async () => {
    const dir = project(MV3);
    respond = () => value({ __extensionDevRelay: 1, done: true, ok: true, value: "relayed" });

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "https://example.com/", expression: AWAITING }),
    );

    expect(result.ok).toBe(true);
    expect(calls[0].expression).toContain(JSON.stringify(`(async () => (${AWAITING}\n))()`));
  });

  it("names top-level await, not a statement list, when the background route refuses it", async () => {
    const dir = project(MV3);
    respond = () =>
      envelope({
        ok: false,
        command: "extension_eval",
        status: "failed",
        error: {
          code: "E_CONTROL_UNAVAILABLE",
          name: "Unavailable",
          message: "SyntaxError: await is only valid in async functions, async generators and modules",
          engine: "firefox",
        },
      });

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "background", expression: AWAITING }),
    );

    expect(result.error.code).toBe("E_BAD_REQUEST");
    expect(result.error.name).toBe("TopLevelAwait");
    expect(result.error.message).toContain("await outside an async function");
    expect(result.error.message).not.toContain("statement list");
    expect(result.hint).toContain("(async () =>");
  });

  it("still refuses a real statement list by name", async () => {
    const dir = project(MV3);
    respond = () => refusedByCsp();

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "popup",
        expression: "const a = await Promise.resolve(1); a",
      }),
    );

    expect(calls).toHaveLength(1);
    expect(result.error.name).toBe("NotOneExpression");
  });
});
