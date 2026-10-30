import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, vi } from "vitest";

import { readyContractPath } from "../lib/session-paths";

export const GUEST_ID = "abcdefghijklmnopabcdefghijklmnop";
export const PAGE_URL = "https://www.youtube.com/watch?v=qSmpCizhtkw";
export const BROWSER = "chrome";
export const BASELINE = ["window", "document", "fetch", "HTMLElement"];

export type Target = { id: string; type: string; url: string; title?: string };
export type PageRead = {
  dom: {
    bytes: number;
    elements: number;
    shadowRoots: number;
    occurrences: number;
    hits: Array<{ tag: string; attribute: string; value: string }>;
  };
  ownNames: string[];
  symbols: string[];
  refs: Array<{ name: string; where: string; value: string }>;
};

export const live = {
  project: "",
  targets: [] as Array<{ id: string; type: string; url: string; title?: string }>,
  pageRead: null as unknown,
  baselineNames: [] as string[],
  frameBaselineNames: null as string[] | null,
  probeAnswers: [] as Array<Record<string, unknown>>,
  probeExpressions: [] as string[],
  created: [] as Array<Record<string, unknown>>,
  closed: [] as string[],
  attached: [] as string[],
  readThrows: null as string | null,
  port: 9222 as number | null,
};

vi.mock("../lib/cdp", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeCdp {
    static async discoverTargets() {
      return live.targets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/fake";
    }
    async connect() {}
    async attachToTarget(id: string) {
      live.attached.push(id);

      return `session-${id}`;
    }
    async enableDomains() {}
    async evaluate(sessionId: string, expression: string) {
      if (expression === "Object.getOwnPropertyNames(window)") return live.baselineNames;
      if (expression.includes('createElement("iframe")')) return live.frameBaselineNames;

      if (expression.includes("getOwnPropertySymbols")) {
        if (live.readThrows) throw new Error(live.readThrows);

        return live.pageRead;
      }

      return sessionId.includes("sw") ? GUEST_ID : undefined;
    }
    async sendCommand(method: string, params: Record<string, unknown>) {
      if (method === "Target.createTarget") {
        live.created.push(params);

        return { targetId: "blank-1" };
      }

      if (method === "Target.closeTarget") {
        live.closed.push(String(params.targetId));

        return {};
      }

      if (method === "Runtime.evaluate" && String(params.expression).includes("fetch(")) {
        live.probeExpressions.push(String(params.expression));

        return { result: { value: live.probeAnswers } };
      }

      return {};
    }
    disconnect() {}
  }

  return { ...actual, CDPClient: FakeCdp };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return {
    ...actual,
    resolveCdpPort: async () => (live.port === null ? null : { port: live.port }),
  };
});

export const STATIC_MANIFEST = {
  manifest_version: 3,
  content_scripts: [{ matches: ["https://*.youtube.com/*"], js: ["content.js"] }],
  web_accessible_resources: [
    { resources: ["bridge.js"], matches: ["<all_urls>"], use_dynamic_url: true },
    { resources: ["images/logo.png"], matches: ["<all_urls>"] },
  ],
};

export function writeManifest(manifest: Record<string, unknown>): void {
  const file = path.join(live.project, "dist", BROWSER, "manifest.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest));
}

export function writeDistFile(relative: string): void {
  const file = path.join(live.project, "dist", BROWSER, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
}

export function writeSourceManifest(manifest: Record<string, unknown>): void {
  fs.writeFileSync(path.join(live.project, "manifest.json"), JSON.stringify(manifest));
}

export function liveSession(command?: "dev" | "start"): void {
  const file = readyContractPath(live.project, BROWSER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      status: "ready",
      ...(command ? { command } : {}),
      pid: process.pid,
      runId: "run-1",
      instanceId: "inst-1",
      distPath: path.join(live.project, "dist", BROWSER),
      extensionId: GUEST_ID,
      cdpPort: 9222,
    }),
  );
}

export function cleanRead(): PageRead {
  return {
    dom: { bytes: 120_000, elements: 900, shadowRoots: 2, occurrences: 0, hits: [] },
    ownNames: [...BASELINE],
    symbols: [],
    refs: [],
  };
}

export function openPage(): void {
  live.targets = [
    { id: "sw", type: "service_worker", url: `chrome-extension://${GUEST_ID}/sw.js` },
    { id: "tab", type: "page", url: PAGE_URL, title: "a video" },
  ];
}

export async function assertOnce(clause: Record<string, unknown>, browser = BROWSER) {
  const { handler } = await import("../tools/assert");
  const raw = await handler({ projectPath: live.project, browser, expect: [clause] });
  const frame = JSON.parse(raw);

  return { frame, check: frame.value?.checks?.[0] };
}

export function usePageWorldProject(): void {
  beforeEach(() => {
    live.project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-assert-page-world-"));
    live.targets = [];
    live.pageRead = cleanRead();
    live.baselineNames = [...BASELINE];
    live.frameBaselineNames = [...BASELINE];
    live.probeAnswers = [{ index: 1, ok: false, error: "Failed to fetch" }];
    live.probeExpressions = [];
    live.created = [];
    live.closed = [];
    live.attached = [];
    live.readThrows = null;
    live.port = 9222;
  });

  afterEach(() => {
    fs.rmSync(live.project, { recursive: true, force: true });
  });
}
