import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readyContractPath } from "../lib/session-paths";

const GUEST_ID = "abcdefghijklmnopabcdefghijklmnop";
const PAGE_URL = "https://www.youtube.com/watch?v=qSmpCizhtkw";

type Target = { id: string; type: string; url: string; title?: string };
type PageRead = {
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

const BASELINE = ["window", "document", "fetch", "HTMLElement"];

const live = vi.hoisted(() => ({
  targets: [] as Target[],
  pageRead: null as unknown,
  baselineNames: [] as string[],
  probeAnswers: [] as Array<Record<string, unknown>>,
  probeExpressions: [] as string[],
  created: [] as Array<Record<string, unknown>>,
  closed: [] as string[],
  attached: [] as string[],
  readThrows: null as string | null,
  port: 9222 as number | null,
}));

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

const { handler } = await import("../tools/assert");
const { pageWorldReadScript, resourceProbeScript } = await import("../tools/assert-page-world-reads");

const BROWSER = "chrome";

let project: string;

function writeManifest(manifest: Record<string, unknown>): void {
  const file = path.join(project, "dist", BROWSER, "manifest.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest));
}

function writeDistFile(relative: string): void {
  const file = path.join(project, "dist", BROWSER, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
}

function liveSession(): void {
  const file = readyContractPath(project, BROWSER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      status: "ready",
      pid: process.pid,
      runId: "run-1",
      instanceId: "inst-1",
      distPath: path.join(project, "dist", BROWSER),
      extensionId: GUEST_ID,
      cdpPort: 9222,
    }),
  );
}

function cleanRead(): PageRead {
  return {
    dom: { bytes: 120_000, elements: 900, shadowRoots: 2, occurrences: 0, hits: [] },
    ownNames: [...BASELINE],
    symbols: [],
    refs: [],
  };
}

function openPage(): void {
  live.targets = [
    { id: "sw", type: "service_worker", url: `chrome-extension://${GUEST_ID}/sw.js` },
    { id: "tab", type: "page", url: PAGE_URL, title: "a video" },
  ];
}

async function assertOnce(clause: Record<string, unknown>, browser = BROWSER) {
  const raw = await handler({ projectPath: project, browser, expect: [clause] });
  const frame = JSON.parse(raw);

  return { frame, check: frame.value?.checks?.[0] };
}

const STATIC_MANIFEST = {
  manifest_version: 3,
  content_scripts: [{ matches: ["https://*.youtube.com/*"], js: ["content.js"] }],
  web_accessible_resources: [
    { resources: ["bridge.js"], matches: ["<all_urls>"], use_dynamic_url: true },
    { resources: ["images/logo.png"], matches: ["<all_urls>"] },
  ],
};

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-assert-page-world-"));
  live.targets = [];
  live.pageRead = cleanRead();
  live.baselineNames = [...BASELINE];
  live.probeAnswers = [{ index: 1, ok: false, error: "Failed to fetch" }];
  live.probeExpressions = [];
  live.created = [];
  live.closed = [];
  live.attached = [];
  live.readThrows = null;
  live.port = 9222;
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe("page-world-clean", () => {
  it("passes a clean page and states what it looked at", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();

    const { frame, check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(frame.ok).toBe(true);
    expect(check.subject).toBe(PAGE_URL);
    expect(check.detail).toMatch(/120,000 bytes of outerHTML/);
    expect(check.detail).toMatch(/900 elements/);
    expect(check.detail).toMatch(/4 own window propert/);
    expect(check.detail).toMatch(/1 static web_accessible_resources path/);
    expect(check.detail).toMatch(/web_accessible_resources\[0\] declares use_dynamic_url/);
    expect(check.evidence.resources.probed[0]).toMatchObject({ index: 1, path: "images/logo.png", ok: false });
    expect(live.probeExpressions[0]).toContain(`chrome-extension://${GUEST_ID}/images/logo.png`);
  });

  it("fails on a DOM attribute carrying the extension base url and names the element", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    const read = cleanRead();
    read.dom.occurrences = 1;
    read.dom.hits = [{ tag: "html", attribute: "data-extjs-extension-base", value: `chrome-extension://${GUEST_ID}/` }];
    live.pageRead = read;

    const { frame, check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("fail");
    expect(frame.ok).toBe(false);
    expect(check.detail).toMatch(/1 DOM reference/);
    expect(check.detail).toContain('html[data-extjs-extension-base]="chrome-extension://');
    expect(check.evidence.dom.hits).toHaveLength(1);
  });

  it("fails on a symbol marker left on window, reported by its description", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    const read = cleanRead();
    read.symbols = ["soccer-lens-media-hook"];
    live.pageRead = read;

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toContain("Symbol(soccer-lens-media-hook)");
  });

  it("fails on a window global whose value names the extension", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    const read = cleanRead();
    read.ownNames.push("__EXTJS_EXTENSION_BASE__");
    read.refs = [{ name: "__EXTJS_EXTENSION_BASE__", where: "value", value: `chrome-extension://${GUEST_ID}/` }];
    live.pageRead = read;

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toMatch(/1 window global naming the extension \(__EXTJS_EXTENSION_BASE__ = "chrome-extension:/);
    expect(check.detail).not.toMatch(/Warning: .*__EXTJS_EXTENSION_BASE__/);
  });

  it("fails when a static web_accessible_resources path answers from the page", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    live.probeAnswers = [{ index: 1, ok: true, status: 200 }];

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toContain(`web_accessible_resources[1] answers 200 at chrome-extension://${GUEST_ID}/images/logo.png`);
    expect(check.detail).toMatch(/fingerprintable by url guessing/);
    expect(check.detail).toMatch(/web_accessible_resources\[0\] declares use_dynamic_url/);
  });

  it("resolves a glob against the built dist and says which globs it could not", async () => {
    writeManifest({
      ...STATIC_MANIFEST,
      web_accessible_resources: [
        { resources: ["images/*.png"], matches: ["<all_urls>"] },
        { resources: ["fonts/*.woff2"], matches: ["<all_urls>"] },
      ],
    });

    writeDistFile("images/logo.png");
    liveSession();
    openPage();
    live.probeAnswers = [{ index: 0, ok: false, error: "Failed to fetch" }];

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(check.evidence.resources.probed).toEqual([
      expect.objectContaining({ index: 0, path: "images/logo.png", pattern: "images/*.png" }),
    ]);

    expect(check.detail).toMatch(/web_accessible_resources\[1\] .*fonts\/\*\.woff2.*could not be resolved/);
  });

  it("says a refused resource is unproven when the entry's matches do not cover the page", async () => {
    writeManifest({
      ...STATIC_MANIFEST,
      web_accessible_resources: [{ resources: ["images/logo.png"], matches: ["https://shop.example/*"] }],
    });

    liveSession();
    openPage();
    live.probeAnswers = [{ index: 0, ok: false, error: "Failed to fetch" }];

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(check.detail).toMatch(/web_accessible_resources\[0\] .*not covered by its matches \(https:\/\/shop\.example\/\*\)/);
  });

  it("reports globals absent from about:blank as a warning, never a fail, and honors pageGlobals", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    const read = cleanRead();
    read.ownNames.push("ytInitialData", "ytcfg");
    live.pageRead = read;

    const warned = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(warned.check.outcome).toBe("pass");
    expect(warned.check.detail).toMatch(/Warning: 2 own window propert.* \(ytInitialData, ytcfg\)/);
    expect(warned.check.evidence.globals.unknown).toEqual(["ytInitialData", "ytcfg"]);

    live.pageRead = read;
    const listed = await assertOnce({ assert: "page-world-clean", url: PAGE_URL, pageGlobals: ["ytInitialData", "ytcfg"] });
    expect(listed.check.outcome).toBe("pass");
    expect(listed.check.detail).not.toMatch(/Warning/);
    expect(listed.check.evidence.globals.unknown).toEqual([]);
  });

  it("opens a background about:blank tab for the baseline and closes it, or reuses one already open", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();

    await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(live.created).toEqual([{ url: "about:blank", background: true }]);
    expect(live.closed).toEqual(["blank-1"]);

    live.created = [];
    live.closed = [];
    live.pageRead = cleanRead();
    live.targets = [...live.targets, { id: "spare", type: "page", url: "about:blank" }];
    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(live.created).toEqual([]);
    expect(live.closed).toEqual([]);
    expect(live.attached).toContain("spare");
  });

  it("is inconclusive when the page is not open and says to open it", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    live.targets = [
      { id: "sw", type: "service_worker", url: `chrome-extension://${GUEST_ID}/sw.js` },
      { id: "other", type: "page", url: "https://shop.example/cart" },
    ];

    const { frame, check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("inconclusive");
    expect(frame.ok).toBe(false);
    expect(check.detail).toContain(PAGE_URL);
    expect(check.settledBy).toContain("extension_open");
    expect(live.created).toEqual([]);
  });

  it("is inconclusive when the main world does not answer the read", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    live.readThrows = "the page threw while evaluating: Debugger paused";

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toContain("Debugger paused");
  });

  it("is inconclusive on Firefox and says what would settle it", async () => {
    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL }, "firefox");
    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toContain("firefox");
    expect(check.settledBy).toContain("extension_eval");
    expect(check.settledBy).toContain("moz-extension://");
  });

  it("requires a url", async () => {
    const { frame } = await assertOnce({ assert: "page-world-clean" });
    expect(frame.ok).toBe(false);
    expect(frame.error.message).toContain("expect[0].url is required");
  });

  it("ships main-world scripts the browser can compile", () => {
    expect(() => new vm.Script(pageWorldReadScript(GUEST_ID))).not.toThrow();
    expect(() => new vm.Script(resourceProbeScript([{ index: 1, url: `chrome-extension://${GUEST_ID}/a.png` }]))).not.toThrow();
    expect(pageWorldReadScript(GUEST_ID)).toContain("getOwnPropertySymbols");
    expect(resourceProbeScript([])).toContain("fetch(");
  });
});
