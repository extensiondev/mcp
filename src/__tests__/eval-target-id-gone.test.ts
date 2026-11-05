import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import { writeEvalToken } from "./fixtures/ready-contract";

import type * as CdpPortModule from "../lib/cdp-port";

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return { ...actual, resolveCdpPort: async () => ({ port: 9222, source: "contract" as const }) };
});

type Target = { id: string; type: string; url: string; title: string };
let listings: Target[][] = [];
let evaluations = 0;
let onEvaluate: () => Record<string, unknown> = () => ({ result: { type: "number", value: 1 } });
vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return listings.length > 1 ? listings.shift()! : (listings[0] ?? []);
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    async connect() {}
    async attachToTarget(targetId: string) {
      return `session-${targetId}`;
    }
    async sendCommand(method: string) {
      if (method === "Runtime.evaluate") {
        evaluations += 1;

        return onEvaluate();
      }

      return {};
    }
    disconnect() {}
  }

  return { CDPClient };
});

const evalTool = await import("../tools/eval");

const dirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-gone-"));
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

const GONE = { id: "59FB47580015721574A55655EDCB2998", type: "page", url: "https://a.test/", title: "A" };
const OTHER = { id: "OTHER1", type: "page", url: "https://b.test/", title: "B" };

function cdpGone(): never {
  throw new Error('{"code":-32000,"message":"Inspected target navigated or closed"}');
}

afterEach(() => {
  listings = [];
  evaluations = 0;
  onEvaluate = () => ({ result: { type: "number", value: 1 } });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("399: extension_eval by targetId on a tab that has gone answers like extension_screenshot", () => {
  it("answers E_TARGET_NOT_FOUND with the live targets when the target closed between the listing and the call", async () => {
    const dir = project();
    listings = [[GONE, OTHER], [OTHER]];
    onEvaluate = cdpGone;

    const result = JSON.parse(await evalTool.handler({ projectPath: dir, browser: "chrome", targetId: GONE.id, expression: "1" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("target-not-found");
    expect(result.error.code).toBe("E_TARGET_NOT_FOUND");
    expect(result.error.message).toContain(GONE.id);
    expect(result.error.message).toContain(OTHER.id);
    expect(result.value.liveTargets).toEqual([{ targetId: OTHER.id, url: OTHER.url }]);
    expect(result.hint).not.toMatch(/extension_doctor/);
    expect(evaluations).toBe(1);
  });

  it("retries once on the same target when it only navigated, and names the new url", async () => {
    const dir = project();
    const landed = { ...GONE, url: "https://a.test/next" };
    listings = [[GONE], [landed]];
    let first = true;

    onEvaluate = () => {
      if (first) {
        first = false;
        cdpGone();
      }

      return { result: { type: "string", value: "after" } };
    };

    const result = JSON.parse(await evalTool.handler({ projectPath: dir, browser: "chrome", targetId: GONE.id, expression: "location.href" }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("evaluated");
    expect(result.value).toBe("after");
    expect(result.warnings.join(" ")).toContain("navigated");
    expect(result.warnings.join(" ")).toContain("https://a.test/next");
    expect(result.hint).toContain("https://a.test/next");
    expect(evaluations).toBe(2);
  });

  it("says the tab navigated and gives its url when the retry fails the same way, instead of sending the agent to extension_doctor", async () => {
    const dir = project();
    const landed = { ...GONE, url: "https://a.test/next" };
    listings = [[GONE], [landed]];
    onEvaluate = cdpGone;

    const result = JSON.parse(await evalTool.handler({ projectPath: dir, browser: "chrome", targetId: GONE.id, expression: "1" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("cdp-failed");
    expect(result.error.code).toBe("E_CDP");
    expect(result.value).toEqual({ targetId: GONE.id, url: "https://a.test/next", navigated: true });
    expect(result.hint).toContain("navigated");
    expect(result.hint).toContain("https://a.test/next");
    expect(result.hint).not.toMatch(/extension_doctor/);
    expect(evaluations).toBe(2);
  });

  it("keeps a plain debug-port refusal as E_CDP without re-listing or retrying", async () => {
    const dir = project();
    listings = [[GONE]];

    onEvaluate = () => {
      throw new Error("Protocol error: Runtime.evaluate is not allowed here");
    };

    const result = JSON.parse(await evalTool.handler({ projectPath: dir, browser: "chrome", targetId: GONE.id, expression: "1" }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_CDP");
    expect(result.value).toBeNull();
    expect(evaluations).toBe(1);
  });
});
