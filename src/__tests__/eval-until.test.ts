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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { actVerbAnswer, evalFrame } from "./fixtures/engine-answers";

import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";

const engine = vi.hoisted(() => ({
  answers: [] as string[],
  calls: [] as string[][],
  timeouts: [] as Array<number | undefined>,
  hangsUntilTimeout: false,
}));

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[], _projectPath: string, timeoutMs?: number) => {
      engine.calls.push(cli);
      engine.timeouts.push(timeoutMs);

      if (engine.hangsUntilTimeout) {
        await new Promise((resolve) => setTimeout(resolve, timeoutMs ?? 30_000));
      }

      return engine.answers.length > 1 ? (engine.answers.shift() as string) : engine.answers[0];
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return { ...actual, resolveCdpPort: async () => null };
});

const { handler } = await import("../tools/eval");
const { createServer } = await import("../index");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-until-"));
  engine.answers = [];
  engine.calls = [];
  engine.timeouts = [];
  engine.hangsUntilTimeout = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("eval-until tests never reach the network");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

function project(browser: string, manifest: Record<string, unknown>): void {
  const dist = path.join(dir, "dist", browser);
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest));
}

const answer = (value: unknown) => actVerbAnswer(evalFrame(value), "extension_eval");

describe("extension_eval until", () => {
  it("repeats the eval until it is truthy and answers that value", async () => {
    project("firefox", { manifest_version: 3, name: "F", background: { scripts: ["bg.js"] } });
    engine.answers = [answer(false), answer(0), answer({ masks: 3 })];

    const result = JSON.parse(
      await handler({
        projectPath: dir,
        browser: "firefox",
        context: "background",
        expression: "globalThis.masks && { masks: 3 }",
        until: { timeoutMs: 5000, intervalMs: 100 },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.command).toBe("extension_eval");
    expect(result.status).toBe("condition-met");
    expect(result.value.result).toEqual({ masks: 3 });
    expect(result.value.polls).toBe(3);
    expect(engine.calls).toHaveLength(3);
    expect(engine.calls[0]).toEqual(expect.arrayContaining(["eval", "--context", "background", "globalThis.masks && { masks: 3 }"]));
  });

  it("answers the last value when the budget runs out", async () => {
    project("firefox", { manifest_version: 3, name: "F", background: { scripts: ["bg.js"] } });
    engine.answers = [answer(null)];

    const result = JSON.parse(
      await handler({
        projectPath: dir,
        browser: "firefox",
        context: "background",
        expression: "globalThis.ready",
        until: { timeoutMs: 1200, intervalMs: 200 },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.error.code).toBe("E_WAIT_TIMEOUT");
    expect(result.value.lastResult).toBeNull();
    expect(result.value.polls).toBeGreaterThan(1);
  });

  it("keeps the whole wait inside timeoutMs when every poll blocks in the engine until its own timeout", async () => {
    project("firefox", { manifest_version: 3, name: "F", background: { scripts: ["bg.js"] } });
    engine.answers = [answer(null)];
    engine.hangsUntilTimeout = true;
    const started = Date.now();

    const result = JSON.parse(
      await handler({
        projectPath: dir,
        browser: "firefox",
        context: "background",
        expression: "new Promise(() => {})",
        until: { timeoutMs: 1000, intervalMs: 100 },
      }),
    );
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(elapsed).toBeLessThan(2500);
    expect(engine.timeouts.every((timeout) => typeof timeout === "number" && timeout <= 1000)).toBe(true);
  }, 10_000);

  it("keeps a caller's smaller timeout for each poll", async () => {
    project("firefox", { manifest_version: 3, name: "F", background: { scripts: ["bg.js"] } });
    engine.answers = [answer(null), answer(true)];

    const result = JSON.parse(
      await handler({
        projectPath: dir,
        browser: "firefox",
        context: "background",
        expression: "globalThis.ready",
        timeout: 400,
        until: { timeoutMs: 5000, intervalMs: 100 },
      }),
    );

    expect(result.status).toBe("condition-met");
    expect(engine.timeouts).toEqual([400, 400]);
  });

  it("stops at a refusal that polling cannot change", async () => {
    project("chrome", { manifest_version: 3, name: "C", background: { service_worker: "sw.js" } });

    const result = JSON.parse(
      await handler({
        projectPath: dir,
        browser: "chrome",
        context: "background",
        expression: "1",
        until: { timeoutMs: 3000, intervalMs: 100 },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("eval-disabled");
    expect(result.value.polls).toBe(1);
  });
});

describe("extension_wait stays read-only now that the condition wait lives in extension_eval", () => {
  it("lists extension_wait read-only and without until, and extension_eval with until", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    const client = new Client({ name: "eval-until-probe", version: "0.0.0" });
    await client.connect(clientTransport);

    const listed = (await client.listTools()).tools;
    const wait = listed.find((t) => t.name === "extension_wait");
    const evalTool = listed.find((t) => t.name === "extension_eval");

    expect(wait?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(Object.keys(wait?.inputSchema.properties ?? {})).not.toContain("until");
    expect(Object.keys(evalTool?.inputSchema.properties ?? {})).toContain("until");
  });
});
