import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readyContractPath } from "../lib/session-paths";

import type * as ExecModule from "../lib/exec";

const GUEST_ID = "abcdefghijklmnopabcdefghijklmnop";
const OTHER_ID = "ppppppppppppppppppppppppppppppppp".slice(0, 32);

type Target = { targetId: string; type: string; url: string; title?: string };

const live = vi.hoisted(() => ({
  targets: [] as Target[],
  browserString: "HeadlessChrome/133.0.6943.53" as string | null,
  userAgent: "Mozilla/5.0 HeadlessChrome/133.0.6943.53" as string | null,
  port: 9222 as number | null,
  answers: {} as Record<string, unknown>,
  throws: {} as Record<string, string>,
  hangs: new Set<string>(),
  attachFails: new Set<string>(),
  evaluated: [] as Array<{ targetId: string; expression: string }>,
  disconnects: 0,
  connects: 0,
}));

const cli = vi.hoisted(() => ({
  response: { code: 0, stdout: "", stderr: "" },
}));

vi.mock("../lib/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof ExecModule>()),
  runExtensionCli: async () => cli.response,
  pinnedCliVersion: () => "",
}));

vi.mock("../lib/engine-version", () => ({
  refusedTheOutputFlag: () => false,
  outputFlagRefusalMessage: async () => "unused",
}));

vi.mock("../lib/cdp", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeCdp {
    static async discoverTargets() {
      return live.targets.map((t) => ({ id: t.targetId, type: t.type, url: t.url, title: t.title ?? "" }));
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/fake";
    }
    static async discoverBrowserVersion() {
      return live.browserString;
    }
    static async discoverUserAgent() {
      return live.userAgent;
    }
    async connect() {
      live.connects += 1;
    }
    async getTargets() {
      return live.targets;
    }
    async attachToTarget(id: string) {
      if (live.attachFails.has(id)) throw new Error(`No target with given id found: ${id}`);

      return `session-${id}`;
    }
    async evaluateAwaited(sessionId: string, expression: string) {
      const targetId = sessionId.replace(/^session-/, "");
      live.evaluated.push({ targetId, expression });
      if (live.hangs.has(targetId)) return new Promise(() => {});
      if (live.throws[targetId]) throw new Error(live.throws[targetId]);

      return live.answers[targetId];
    }
    async evaluate() {
      throw new Error("the capabilities probe must await its promise");
    }
    disconnect() {
      live.disconnects += 1;
    }
  }

  return { ...actual, CDPClient: FakeCdp };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return {
    ...actual,
    resolveCdpPort: async () => (live.port === null ? null : { port: live.port, source: "contract" }),
  };
});

const { handler, schema } = await import("../tools/doctor");
const { readSessionCapabilities } = await import("../lib/session-capabilities");

let project: string;

function engineEnvelope(): string {
  return JSON.stringify({
    schema: 1,
    ok: true,
    command: "doctor",
    status: "healthy",
    value: [
      { check: "ready-contract", status: "pass", detail: "status ready" },
      { check: "browser", status: "pass", detail: "browser alive on cdpPort 9222" },
    ],
    error: null,
    warnings: [],
  });
}

function writeReady(browser: string): void {
  const file = readyContractPath(project, browser);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      status: "ready",
      pid: process.pid,
      runId: "run-1",
      instanceId: "inst-1",
      distPath: path.join(project, "dist", browser),
      extensionId: GUEST_ID,
      cdpPort: 9222,
    }),
  );
}

function gpuAnswer(kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind,
    crossOriginIsolated: false,
    hardwareConcurrency: 10,
    videoDecoder: true,
    gpu: {
      adapter: true,
      vendor: "apple",
      architecture: "metal-3",
      device: "",
      description: "",
      features: ["shader-f16", "texture-compression-etc2"],
      limits: { maxBufferSize: 4294967296, maxComputeWorkgroupSizeX: 1024 },
      isFallbackAdapter: false,
    },
    ...extra,
  };
}

const extensionTargets: Target[] = [
  { targetId: "sw", type: "service_worker", url: `chrome-extension://${GUEST_ID}/background.js` },
  { targetId: "popup", type: "page", url: `chrome-extension://${GUEST_ID}/popup.html`, title: "Popup" },
  { targetId: "off", type: "page", url: `chrome-extension://${GUEST_ID}/offscreen.html` },
  { targetId: "frame", type: "iframe", url: `chrome-extension://${GUEST_ID}/overlay.html` },
  { targetId: "wk", type: "worker", url: `chrome-extension://${GUEST_ID}/inference.worker.js` },
];

const bystanders: Target[] = [
  { targetId: "tab", type: "page", url: "https://www.youtube.com/watch?v=abc", title: "Match" },
  { targetId: "other-sw", type: "service_worker", url: `chrome-extension://${OTHER_ID}/sw.js` },
  { targetId: "devtools", type: "page", url: "devtools://devtools/bundled/devtools_app.html" },
];

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-doctor-capabilities-"));
  cli.response = { code: 0, stdout: engineEnvelope(), stderr: "" };
  live.targets = [...extensionTargets, ...bystanders];
  live.browserString = "HeadlessChrome/133.0.6943.53";
  live.userAgent = "Mozilla/5.0 HeadlessChrome/133.0.6943.53";
  live.port = 9222;
  live.answers = {
    sw: gpuAnswer("service-worker", { videoDecoder: false }),
    popup: gpuAnswer("extension-page"),
    off: gpuAnswer("offscreen-document", { crossOriginIsolated: true }),
    frame: gpuAnswer("extension-frame"),
    wk: gpuAnswer("worker"),
  };

  live.throws = {};
  live.hangs = new Set();
  live.attachFails = new Set();
  live.evaluated = [];
  live.disconnects = 0;
  live.connects = 0;
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

async function doctor(browser: string) {
  return JSON.parse(await handler({ projectPath: project, browser }));
}

describe("extension_doctor reads the Chromium session's compute capabilities", () => {
  it("answers one row per context of the session's extension with the WebGPU adapter, isolation and the headless reading", async () => {
    writeReady("chrome");

    const out = await doctor("chrome");

    expect(out.ok).toBe(true);
    expect(out.status).toBe("healthy");
    expect(out.value.capabilities.headless).toBe(true);
    expect(out.value.capabilities.browser).toBe("HeadlessChrome/133.0.6943.53");
    expect(out.value.capabilities.extensionId).toBe(GUEST_ID);

    const rows = out.value.capabilities.contexts as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.targetId)).toEqual(["sw", "popup", "off", "frame", "wk"]);
    expect(rows.map((r) => r.kind)).toEqual([
      "service-worker",
      "extension-page",
      "offscreen-document",
      "extension-frame",
      "worker",
    ]);

    const offscreen = rows[2]!;
    expect(offscreen.url).toBe(`chrome-extension://${GUEST_ID}/offscreen.html`);
    expect(offscreen.crossOriginIsolated).toBe(true);
    expect(offscreen.hardwareConcurrency).toBe(10);
    expect(offscreen.videoDecoder).toBe(true);
    expect(offscreen.gpu).toEqual({
      adapter: true,
      vendor: "apple",
      architecture: "metal-3",
      device: "",
      description: "",
      features: ["shader-f16", "texture-compression-etc2"],
      limits: { maxBufferSize: 4294967296, maxComputeWorkgroupSizeX: 1024 },
      isFallbackAdapter: false,
    });

    expect(rows[0]!.videoDecoder).toBe(false);
    expect(rows.every((r) => r.error === undefined)).toBe(true);
    expect(live.evaluated.map((e) => e.targetId)).not.toContain("tab");
    expect(live.evaluated.map((e) => e.targetId)).not.toContain("other-sw");
    expect(live.connects).toBe(1);
    expect(live.disconnects).toBe(1);
  });

  it("evaluates a probe that asks the adapter for its info, features, limits and fallback flag with the promise awaited", async () => {
    writeReady("chrome");

    await doctor("chrome");

    const probe = live.evaluated.find((e) => e.targetId === "popup")!.expression;

    for (const needle of [
      "navigator.gpu",
      "requestAdapter()",
      "requestAdapterInfo",
      "adapter.info",
      "features",
      "maxBufferSize",
      "maxComputeWorkgroupSizeX",
      "isFallbackAdapter",
      "crossOriginIsolated",
      "hardwareConcurrency",
      "VideoDecoder",
    ]) {
      expect(probe, needle).toContain(needle);
    }
  });

  it("reads headless from the User-Agent when the Browser string does not say it, and null when neither is readable", async () => {
    writeReady("chrome");
    live.browserString = "Chrome/133.0.6943.53";
    live.userAgent = "Mozilla/5.0 (Macintosh) HeadlessChrome/133.0.6943.53 Safari/537.36";

    expect((await doctor("chrome")).value.capabilities.headless).toBe(true);

    live.userAgent = "Mozilla/5.0 (Macintosh) Chrome/133.0.6943.53 Safari/537.36";
    expect((await doctor("chrome")).value.capabilities.headless).toBe(false);

    live.browserString = null;
    live.userAgent = null;
    expect((await doctor("chrome")).value.capabilities.headless).toBeNull();
  });

  it("keeps the doctor healthy when a context cannot be attached or its probe throws, answering those rows with an error", async () => {
    writeReady("chrome");
    live.attachFails = new Set(["wk"]);
    live.throws = { frame: "the page threw while evaluating: SecurityError: navigator.gpu is blocked" };

    const out = await doctor("chrome");

    expect(out.ok).toBe(true);
    expect(out.status).toBe("healthy");

    const rows = out.value.capabilities.contexts as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.targetId === "wk")!.error).toMatch(/No target with given id/);
    expect(rows.find((r) => r.targetId === "wk")!.kind).toBe("worker");
    expect(rows.find((r) => r.targetId === "frame")!.error).toMatch(/navigator\.gpu is blocked/);
    expect(rows.find((r) => r.targetId === "frame")!.gpu).toBeUndefined();
    expect(rows.find((r) => r.targetId === "popup")!.gpu).toMatchObject({ adapter: true });
  });

  it("caps each context's probe and answers a hung one as an error instead of holding the doctor", async () => {
    writeReady("chrome");
    live.hangs = new Set(["sw"]);

    const started = Date.now();
    const read = await readSessionCapabilities(project, "chrome", { targetTimeoutMs: 60 });

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(read.capabilities).not.toBeNull();

    const rows = read.capabilities!.contexts;
    expect(rows.find((r) => r.targetId === "sw")!.error).toMatch(/did not answer within 60 ms/);
    expect(rows.find((r) => r.targetId === "popup")!.error).toBeUndefined();
  });

  it("answers capabilities: null with a reason when the Chromium session has no debug port", async () => {
    writeReady("chrome");
    live.port = null;

    const out = await doctor("chrome");

    expect(out.ok).toBe(true);
    expect(out.value.capabilities).toBeNull();
    expect(out.value.capabilitiesReason).toMatch(/no CDP port/);
    expect(live.evaluated).toHaveLength(0);
  });

  it("answers capabilities: null with a reason when the browser lists no target of the extension", async () => {
    writeReady("chrome");
    live.targets = [...bystanders];

    const out = await doctor("chrome");

    expect(out.ok).toBe(true);
    expect(out.value.capabilities).toBeNull();
    expect(out.value.capabilitiesReason).toMatch(/no target/);
  });

  it("answers capabilities: null with a one-sentence reason on a Firefox session", async () => {
    writeReady("firefox");

    const out = await doctor("firefox");

    expect(out.ok).toBe(true);
    expect(out.value.capabilities).toBeNull();
    expect(out.value.capabilitiesReason).toMatch(/^Firefox sessions have no Chromium debug port[^.]*\.$/);
    expect(live.evaluated).toHaveLength(0);
  });

  it("names the reading in the tool description", () => {
    expect(schema.description).toMatch(/capabilities/);
  });
});
