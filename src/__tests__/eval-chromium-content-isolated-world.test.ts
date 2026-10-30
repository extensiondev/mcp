// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { envelope } from "../lib/envelope";
import { extensionIsolatedContexts, type ExecutionContextDescription } from "../lib/cdp-isolated-world";
import { writeEvalToken } from "./fixtures/ready-contract";
import { actVerbAnswer, evalRefusal } from "./fixtures/engine-answers";

import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";

const cliCalls: string[][] = [];
let relayReply: () => string = () => envelope({ ok: true, command: "extension_eval", status: "ok", value: "relay" });
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      cliCalls.push(cli);

      return relayReply();
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return { ...actual, resolveCdpPort: async () => ({ port: 9222, source: "contract" }) };
});

type Target = { id: string; type: string; url: string; title: string };
let cdpTargets: Target[] = [];
let contexts: ExecutionContextDescription[] = [];
let worlds: Record<number, Record<string, unknown>> = {};
const evaluations: Array<{ params: Record<string, unknown>; sessionId?: string }> = [];
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
    async executionContexts() {
      return contexts;
    }
    async sendCommand(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
      if (method === "Runtime.evaluate") {
        evaluations.push({ params, sessionId });
        const value = vm.runInNewContext(String(params.expression), { ...(worlds[Number(params.contextId)] ?? {}) }) as unknown;

        return { result: value === undefined ? { type: "undefined" } : { type: typeof value, value } };
      }

      return {};
    }
    disconnect() {}
  }

  return { CDPClient };
});

const evalTool = await import("../tools/eval");

function unpackedId(distPath: string): string {
  const d = crypto.createHash("sha256").update(distPath).digest();
  let id = "";

  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (d[i] >> 4));
    id += String.fromCharCode(97 + (d[i] & 0x0f));
  }

  return id;
}

let dir: string;
let extensionId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-isolated-"));
  const distPath = path.join(dir, "dist", "chrome");
  fs.mkdirSync(distPath, { recursive: true });
  fs.writeFileSync(
    path.join(distPath, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Mask",
      background: { service_worker: "background.js" },
      content_scripts: [{ matches: ["https://www.google.com/*"], js: ["content.js"] }],
      content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'" },
    }),
  );

  const readyDir = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify({ status: "ready", distPath }));
  writeEvalToken(dir, "chrome");
  extensionId = unpackedId(distPath);

  cdpTargets = [
    { id: "sw", type: "service_worker", url: `chrome-extension://${extensionId}/background.js`, title: "" },
    { id: "google", type: "page", url: "https://www.google.com/search?q=pii", title: "pii - Google Search" },
  ];

  contexts = [
    { id: 1, origin: "https://www.google.com", name: "", auxData: { isDefault: true, type: "default", frameId: "google" } },
    { id: 7, origin: `chrome-extension://${extensionId}`, name: "Mask", auxData: { isDefault: false, type: "isolated", frameId: "google" } },
  ];

  worlds = { 7: { chrome: { runtime: { id: extensionId, sendMessage() {} } }, masked: true } };
});

function userEvaluations(expression: string) {
  return evaluations.filter((evaluation) => evaluation.params.expression === expression);
}

afterEach(() => {
  cliCalls.length = 0;
  evaluations.length = 0;
  relayReply = () => envelope({ ok: true, command: "extension_eval", status: "ok", value: "relay" });
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_eval context content on Chromium reaches the content script's isolated world over the debug port", () => {
  it("evaluates in the extension's isolated world of the matching tab and never asks the relay, whose eval the MV3 CSP refuses", async () => {
    relayReply = () =>
      actVerbAnswer(
        evalRefusal({ code: "E_CSP_BLOCKS_EVAL", name: "CspBlocksEval", message: "eval of a string is blocked in the ISOLATED (content) world" }),
        "extension_eval",
      );

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "chrome", context: "content", url: "google.com/search", expression: "typeof chrome.runtime.sendMessage" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("function");
    expect(cliCalls).toEqual([]);
    const ran = userEvaluations("typeof chrome.runtime.sendMessage");
    expect(ran).toHaveLength(1);
    expect(ran[0].sessionId).toBe("session-google");
    expect(ran[0].params.contextId).toBe(7);
    expect(result.hint).toContain("isolated world");
    expect(result.hint).toContain("content_security_policy does not govern");
  });

  it("evaluates in the live content script world after a background reload, not the orphaned world listed first", async () => {
    contexts = [
      contexts[0],
      { id: 7, origin: `chrome-extension://${extensionId}`, name: "Mask", auxData: { isDefault: false, type: "isolated", frameId: "google" } },
      { id: 12, origin: `chrome-extension://${extensionId}`, name: "Mask", auxData: { isDefault: false, type: "isolated", frameId: "google" } },
    ];

    worlds = { 7: { chrome: {} }, 12: { chrome: { runtime: { id: extensionId } }, x: 1 } };

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "chrome", context: "content", url: "google.com/search", expression: "globalThis.x" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe(1);
    expect(userEvaluations("globalThis.x").map((evaluation) => evaluation.params.contextId)).toEqual([12]);
    expect(cliCalls).toEqual([]);
  });

  it("answers an error naming the orphaned world when no live content script world is in the tab", async () => {
    worlds = { 7: { chrome: {} } };

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "chrome", context: "content", url: "google.com/search", expression: "globalThis.x" }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("content-world-orphaned");
    expect(result.error.code).toBe("E_CONTENT_WORLD_ORPHANED");
    expect(result.error.message).toContain(`chrome-extension://${extensionId} ("Mask")`);
    expect(result.error.message).toContain("execution context 7");
    expect(result.value.orphanedContextIds).toEqual([7]);
    expect(userEvaluations("globalThis.x")).toEqual([]);
    expect(cliCalls).toEqual([]);
  });

  it("goes through the relay when no content script of this extension has run in the tab", async () => {
    contexts = [
      contexts[0],
      { id: 9, origin: "chrome-extension://someotherextensionidaaaaaaaaaaaaa", name: "Other", auxData: { isDefault: false, type: "isolated", frameId: "google" } },
    ];

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "chrome", context: "content", url: "google.com/search", expression: "1" }),
    );

    expect(evaluations).toEqual([]);
    expect(cliCalls).toHaveLength(1);
    expect(result.value).toBe("relay");
  });

  it("tells a content eval refused by the CSP without a url to name the tab, so the debug port can take it", async () => {
    relayReply = () =>
      actVerbAnswer(
        evalRefusal({ code: "E_CSP_BLOCKS_EVAL", name: "CspBlocksEval", message: "eval of a string is blocked in the ISOLATED (content) world" }),
        "extension_eval",
      );

    const result = JSON.parse(await evalTool.handler({ projectPath: dir, browser: "chrome", context: "content", expression: "1" }));

    expect(result.ok).toBe(false);
    expect(evaluations).toEqual([]);
    expect(result.hint).toContain("pass url naming a tab where the content script has run");
  });
});

describe("extensionIsolatedContexts", () => {
  it("keeps only this extension's isolated world in the top frame", () => {
    const id = "abcdefghijklmnopabcdefghijklmnop";
    const found = extensionIsolatedContexts(
      [
        { id: 1, origin: "https://a.test", auxData: { type: "default", isDefault: true, frameId: "top" } },
        { id: 2, origin: `chrome-extension://${id}`, auxData: { type: "isolated", isDefault: false, frameId: "child" } },
        { id: 3, origin: `chrome-extension://${id}/`, auxData: { type: "isolated", isDefault: false, frameId: "top" } },
        { id: 4, origin: "chrome-extension://another", auxData: { type: "isolated", isDefault: false, frameId: "top" } },
      ],
      id,
      "top",
    );

    expect(found.map((c) => c.id)).toEqual([3]);
  });
});
