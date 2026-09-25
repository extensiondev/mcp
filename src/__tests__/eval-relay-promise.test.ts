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
const relay = await import("../lib/relay-eval");

const dirs: string[] = [];
function project(manifest: Record<string, unknown>, browser = "firefox"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-relay-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", browser);
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

const GECKO = {
  manifest_version: 2,
  name: "F",
  chrome_url_overrides: { newtab: "newtab/index.html" },
  sidebar_action: { default_panel: "sidebar.html" },
};

const okFrame = (value: unknown) =>
  envelope({ ok: true, command: "extension_eval", status: "ok", value });

function tokenOf(expression: string): string {
  const match = expression.match(/store\["([^"]+)"\]/);
  return match ? match[1] : "";
}

afterEach(() => {
  calls.length = 0;
  respond = () => okFrame(1);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_eval on a relay surface never hands the relay a promise", () => {
  it("wraps the expression so the page settles a promise and polls for the result", async () => {
    const dir = project(GECKO);
    let token = "";
    respond = (call, index) => {
      if (index === 0) {
        expect(call.expression).toContain(relay.RELAY_MARK);
        expect(call.expression).toContain(JSON.stringify("await go()"));
        token = tokenOf(call.expression);
        expect(token).toMatch(/^[0-9a-f-]{36}$/);
        return okFrame({ [relay.RELAY_MARK]: 1, done: false, token });
      }
      if (index === 1) {
        expect(call.expression).toContain(JSON.stringify(token));
        expect(call.expression).not.toContain(JSON.stringify("await go()"));
        return okFrame({ [relay.RELAY_MARK]: 1, done: false, token });
      }
      return okFrame({ [relay.RELAY_MARK]: 1, done: true, ok: true, value: { count: 5 } });
    };

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "newtab",
        expression: "await go()",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ count: 5 });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const idx = call.cli.indexOf("--context");
      expect(call.cli[idx + 1]).toBe("newtab");
    }
    expect(result.hint).toContain("polled 2 times");
  });

  it("returns a synchronous value in one call, unwrapped", async () => {
    const dir = project(GECKO);
    respond = () =>
      okFrame({ [relay.RELAY_MARK]: 1, done: true, ok: true, value: "Title" });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "sidebar",
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("Title");
    expect(calls).toHaveLength(1);
    expect(result.hint ?? "").not.toContain("polled");
  });

  it("reports a rejected promise as E_EVAL with the page's own message", async () => {
    const dir = project(GECKO);
    respond = (_call, index) =>
      index === 0
        ? okFrame({ [relay.RELAY_MARK]: 1, done: false, token: "t2" })
        : okFrame({
            [relay.RELAY_MARK]: 1,
            done: true,
            ok: false,
            name: "TypeError",
            message: "canvas is null",
          });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "newtab",
        expression: "await draw()",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_EVAL");
    expect(result.error.name).toBe("TypeError");
    expect(result.error.message).toBe("canvas is null");
  });

  it("stops polling at the timeout and names where the result will land", async () => {
    const dir = project(GECKO);
    respond = () => okFrame({ [relay.RELAY_MARK]: 1, done: false, token: "t3" });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "newtab",
        expression: "await forever()",
        timeout: 700,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_WAIT_TIMEOUT");
    expect(result.status).toBe("eval-pending");
    expect(result.hint).toContain(relay.RELAY_MARK);
    expect(result.hint).toContain(result.value.token);
    expect(calls.length).toBeGreaterThan(1);
  }, 10_000);

  it("passes an engine refusal through untouched, with the open hint spoken as a tool call", async () => {
    const dir = project(GECKO);
    const { toMcpSpeak } = await import("../lib/act");
    respond = () =>
      envelope({
        ok: false,
        command: "extension_eval",
        status: "not-found",
        error: {
          code: "E_TARGET_NOT_FOUND",
          name: "Unsupported",
          message: toMcpSpeak(
            "surface 'newtab' is not open (open it first: extension open newtab)",
          ),
        },
      });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "newtab",
        expression: "1",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_TARGET_NOT_FOUND");
    expect(result.error.message).toContain('extension_open with surface: "newtab"');
    expect(result.error.message).not.toContain("extension open newtab");
  });

  it("leaves a relay that predates the wrapper shape alone", async () => {
    const dir = project(GECKO);
    respond = () => okFrame("plain");

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "newtab",
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("plain");
  });

  it("does not wrap background or page contexts", async () => {
    const dir = project(GECKO);

    await evalTool.handler({
      projectPath: dir,
      browser: "firefox",
      context: "background",
      expression: "1 + 1",
    });
    await evalTool.handler({
      projectPath: dir,
      browser: "firefox",
      context: "page",
      url: "https://example.com/",
      expression: "1 + 1",
    });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.expression).toBe("1 + 1");
      expect(call.expression).not.toContain(relay.RELAY_MARK);
    }
  });
});

describe("the relay wrapper itself", () => {
  it("evaluates the source, settles a thenable under the token and clones the outcome", async () => {
    const token = "abc";
    const store: Record<string, unknown> = {};
    const g = globalThis as Record<string, unknown>;
    g[relay.RELAY_MARK] = store;
    try {
      const pending = (0, eval)(
        relay.relaySafeExpression("Promise.resolve({ n: 2 })", token),
      );
      expect(pending).toEqual({ [relay.RELAY_MARK]: 1, done: false, token });
      await new Promise((r) => setTimeout(r, 0));
      const settled = (0, eval)(relay.relayPollExpression(token));
      expect(settled).toMatchObject({ done: true, ok: true, value: { n: 2 } });
      expect(store[token]).toBeUndefined();

      const sync = (0, eval)(relay.relaySafeExpression("21 * 2", token));
      expect(sync).toEqual({ [relay.RELAY_MARK]: 1, done: true, ok: true, value: 42 });

      const lost = (0, eval)(relay.relayPollExpression("never-armed"));
      expect(lost).toMatchObject({ done: true, ok: false, name: "RelayLost" });

      const uncloneable = (0, eval)(
        relay.relaySafeExpression("(() => { const f = () => 1; return f; })()", token),
      );
      expect(typeof uncloneable.value).toBe("string");
    } finally {
      delete g[relay.RELAY_MARK];
    }
  });

  it("tells a relay frame from an ordinary object result", () => {
    expect(relay.readRelayFrame({ done: true })).toBeNull();
    expect(relay.readRelayFrame({ [relay.RELAY_MARK]: 1, done: true, ok: true, value: 3 })).toEqual({
      done: true,
      ok: true,
      value: 3,
    });
    expect(relay.readRelayFrame("text")).toBeNull();
    expect(tokenOf(relay.relayPollExpression("zz"))).toBe("zz");
  });
});
