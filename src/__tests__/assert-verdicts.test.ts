import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logsPath, readyContractPath } from "../lib/session-paths";

const GUEST_ID = "abcdefghijklmnopabcdefghijklmnop";
const COMPANION_ID = "kgdaecdpfkikjncaalnmmnjjfpofkcbl";

type Target = { id: string; type: string; url: string; title?: string };

const live = vi.hoisted(() => ({
  targets: [] as Target[],
  render: null as Record<string, unknown> | null,
  probeCount: 0,
  storageFrame: "",
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
      return `session-${id}`;
    }
    async enableDomains() {}
    async getRenderEvidence() {
      return live.render;
    }
    async probeSelectors(_sessionId: string, selectors: string[]) {
      return selectors.map((selector) => ({
        selector,
        count: live.probeCount,
        samples: [],
      }));
    }
    async evaluate() {
      return undefined;
    }
    disconnect() {}
  }
  return { ...actual, CDPClient: FakeCdp };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveCdpPort: async () =>
      live.port === null ? null : { port: live.port },
  };
});

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runActVerb: async () => live.storageFrame };
});

const { handler } = await import("../tools/assert");
const { matchPatternCovers, contentScriptsForbidden } = await import(
  "../lib/match-patterns"
);

const BROWSER = "chrome";

let project: string;

function writeManifest(manifest: Record<string, unknown>): void {
  const file = path.join(project, "dist", BROWSER, "manifest.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest));
}

function writeReady(contract: Record<string, unknown>): void {
  const file = readyContractPath(project, BROWSER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(contract));
}

function writeLogs(events: Array<Record<string, unknown>>): void {
  const file = logsPath(project, BROWSER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

function liveSession(): void {
  writeReady({
    status: "ready",
    pid: process.pid,
    runId: "run-1",
    instanceId: "inst-1",
    distPath: path.join(project, "dist", BROWSER),
    cdpPort: 9222,
  });
}

async function assertOnce(clause: Record<string, unknown>) {
  const raw = await handler({
    projectPath: project,
    browser: BROWSER,
    expect: [clause],
  });
  const frame = JSON.parse(raw);
  return { frame, check: frame.value?.checks?.[0] };
}

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-assert-"));
  live.targets = [];
  live.render = null;
  live.probeCount = 0;
  live.port = 9222;
  live.storageFrame = JSON.stringify({
    schema: 1,
    ok: true,
    command: "extension_assert",
    status: "ok",
    value: {},
    error: null,
    warnings: [],
  });
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe("background-worker-booted", () => {
  it("passes on a live worker target belonging to the guest", async () => {
    writeManifest({ background: { service_worker: "sw.js" } });
    liveSession();
    live.targets = [
      { id: "sw", type: "service_worker", url: `chrome-extension://${GUEST_ID}/sw.js` },
    ];
    const { frame, check } = await assertOnce({
      assert: "background-worker-booted",
    });
    expect(check.outcome).toBe("pass");
    expect(frame.ok).toBe(true);
    expect(frame.value.passed).toBe(true);
  });

  it("fails when the manifest declares no background at all", async () => {
    writeManifest({ name: "x" });
    liveSession();
    const { check } = await assertOnce({ assert: "background-worker-booted" });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toContain("declares no background");
  });

  it("fails when the browser lists no target for the guest", async () => {
    writeManifest({ background: { service_worker: "sw.js" } });
    liveSession();
    live.targets = [
      { id: "companion", type: "page", url: `chrome-extension://${COMPANION_ID}/x.html` },
    ];
    const { check } = await assertOnce({ assert: "background-worker-booted" });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toContain("not loaded");
  });

  /* @invariant The muddy middle. A loaded extension with no worker target is
     the shape a dormant MV3 worker takes, so this must never be a pass and
     never a red against the extension. */
  it("is inconclusive when the guest is loaded but no worker target and no background log exist", async () => {
    writeManifest({ background: { service_worker: "sw.js" } });
    liveSession();
    live.targets = [
      { id: "popup", type: "page", url: `chrome-extension://${GUEST_ID}/popup.html` },
    ];
    const { frame, check } = await assertOnce({
      assert: "background-worker-booted",
    });
    expect(check.outcome).toBe("inconclusive");
    expect(check.settledBy).toContain("extension_open");
    expect(frame.ok).toBe(false);
    expect(frame.status).toBe("inconclusive");
  });

  it("passes on a background log line from the live run when the worker has idled out", async () => {
    writeManifest({ background: { service_worker: "sw.js" } });
    liveSession();
    writeLogs([
      { type: "header", runId: "run-1", v: 1 },
      { context: "background", level: "info", seq: 1, message: "booted" },
    ]);
    live.targets = [
      { id: "popup", type: "page", url: `chrome-extension://${GUEST_ID}/popup.html` },
    ];
    const { check } = await assertOnce({ assert: "background-worker-booted" });
    expect(check.outcome).toBe("pass");
    expect(check.detail).toContain("run run-1");
  });

  it("does not read a past run's background lines as this run's boot", async () => {
    writeManifest({ background: { service_worker: "sw.js" } });
    writeReady({
      status: "ready",
      pid: process.pid,
      runId: "run-2",
      instanceId: "inst-2",
      distPath: path.join(project, "dist", BROWSER),
    });
    writeLogs([
      { type: "header", runId: "run-1", v: 1 },
      { context: "background", level: "info", seq: 1, message: "booted" },
    ]);
    live.targets = [
      { id: "popup", type: "page", url: `chrome-extension://${GUEST_ID}/popup.html` },
    ];
    const { check } = await assertOnce({ assert: "background-worker-booted" });
    expect(check.outcome).toBe("inconclusive");
  });

  it("is inconclusive with no session rather than reporting a boot failure", async () => {
    writeManifest({ background: { service_worker: "sw.js" } });
    live.port = null;
    const { check } = await assertOnce({ assert: "background-worker-booted" });
    expect(check.outcome).toBe("inconclusive");
  });
});

describe("surface-rendered", () => {
  const withPopup = { action: { default_popup: "popup.html" } };

  it("fails when the extension declares no such surface", async () => {
    writeManifest({ options_ui: { page: "options.html" } });
    liveSession();
    const { check } = await assertOnce({
      assert: "surface-rendered",
      surface: "popup",
    });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toContain("declares no popup");
    expect(check.detail).toContain("options");
  });

  it("fails when the surface is declared but nothing is rendering it", async () => {
    writeManifest(withPopup);
    liveSession();
    live.targets = [{ id: "tab", type: "page", url: "https://example.test/" }];
    const { check } = await assertOnce({
      assert: "surface-rendered",
      surface: "popup",
    });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toContain("no page target");
  });

  it("passes when the surface document holds rendered content", async () => {
    writeManifest(withPopup);
    liveSession();
    live.targets = [
      { id: "popup", type: "page", url: `chrome-extension://${GUEST_ID}/popup.html` },
    ];
    live.render = {
      readyState: "complete",
      bodyElementCount: 12,
      textLength: 40,
    };
    const { check } = await assertOnce({
      assert: "surface-rendered",
      surface: "popup",
    });
    expect(check.outcome).toBe("pass");
  });

  it("fails on a mount point with nothing mounted into it", async () => {
    writeManifest(withPopup);
    liveSession();
    live.targets = [
      { id: "popup", type: "page", url: `chrome-extension://${GUEST_ID}/popup.html` },
    ];
    live.render = { readyState: "complete", bodyElementCount: 1, textLength: 0 };
    const { check } = await assertOnce({
      assert: "surface-rendered",
      surface: "popup",
    });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toContain("nothing rendered into it");
  });

  it("is inconclusive while the document is still loading", async () => {
    writeManifest(withPopup);
    liveSession();
    live.targets = [
      { id: "popup", type: "page", url: `chrome-extension://${GUEST_ID}/popup.html` },
    ];
    live.render = { readyState: "loading", bodyElementCount: 0, textLength: 0 };
    const { check } = await assertOnce({
      assert: "surface-rendered",
      surface: "popup",
    });
    expect(check.outcome).toBe("inconclusive");
  });

  it("counts selector matches against minNodes", async () => {
    writeManifest(withPopup);
    liveSession();
    live.targets = [
      { id: "popup", type: "page", url: `chrome-extension://${GUEST_ID}/popup.html` },
    ];
    live.render = { readyState: "complete", bodyElementCount: 9, textLength: 5 };
    live.probeCount = 2;
    const enough = await assertOnce({
      assert: "surface-rendered",
      surface: "popup",
      selector: "li",
      minNodes: 2,
    });
    expect(enough.check.outcome).toBe("pass");
    const short = await assertOnce({
      assert: "surface-rendered",
      surface: "popup",
      selector: "li",
      minNodes: 3,
    });
    expect(short.check.outcome).toBe("fail");
    expect(short.check.detail).toContain("fewer than the 3 expected");
  });
});

describe("content-script-injected", () => {
  const withMatch = {
    content_scripts: [{ matches: ["https://shop.example/*"], js: ["cs.js"] }],
  };

  it("fails on a url no content script can ever reach", async () => {
    writeManifest(withMatch);
    liveSession();
    const { check } = await assertOnce({
      assert: "content-script-injected",
      url: "chrome://extensions/",
    });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toContain("browser interface");
  });

  /* @invariant The requirement this verb exists for: a declared match is a
     statement about the manifest, and passing on it would report the manifest
     while claiming to report the run. */
  it("refuses to pass on a declared match alone", async () => {
    writeManifest(withMatch);
    liveSession();
    const { check } = await assertOnce({
      assert: "content-script-injected",
      url: "https://shop.example/cart",
    });
    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toContain("https://shop.example/*");
    expect(check.detail).toContain("isolated world");
    expect(check.settledBy).toContain("extension_eval");
  });

  it("passes on a line the content script itself wrote at that url", async () => {
    writeManifest(withMatch);
    liveSession();
    writeLogs([
      { type: "header", runId: "run-1", v: 1 },
      {
        context: "content",
        level: "info",
        seq: 1,
        url: "https://shop.example/cart",
        message: "hello",
      },
    ]);
    const { check } = await assertOnce({
      assert: "content-script-injected",
      url: "https://shop.example/cart",
    });
    expect(check.outcome).toBe("pass");
  });

  it("is inconclusive, not failed, when no static match covers the url", async () => {
    writeManifest({ content_scripts: [{ matches: ["https://other.test/*"] }] });
    liveSession();
    const { check } = await assertOnce({
      assert: "content-script-injected",
      url: "https://shop.example/cart",
    });
    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toContain("chrome.scripting.registerContentScripts");
  });
});

describe("storage-key-present", () => {
  const frameWith = (value: unknown, ok = true) =>
    JSON.stringify({
      schema: 1,
      ok,
      command: "extension_assert",
      status: ok ? "ok" : "no-control-channel",
      value,
      error: ok
        ? null
        : {
            code: "E_NO_CONTROL_CHANNEL",
            message: "No active control channel found for chrome.",
          },
      warnings: [],
    });

  it("is inconclusive when the platform refused the read", async () => {
    liveSession();
    live.storageFrame = frameWith(null, false);
    const { check } = await assertOnce({
      assert: "storage-key-present",
      key: "token",
    });
    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toContain("refused the read");
  });

  it("fails when the area holds no such key", async () => {
    liveSession();
    live.storageFrame = frameWith({ other: 1 });
    const { check } = await assertOnce({
      assert: "storage-key-present",
      key: "token",
    });
    expect(check.outcome).toBe("fail");
  });

  it("passes when the key is there, and compares equals when given", async () => {
    liveSession();
    live.storageFrame = frameWith({ token: "abc" });
    const present = await assertOnce({
      assert: "storage-key-present",
      key: "token",
    });
    expect(present.check.outcome).toBe("pass");
    const match = await assertOnce({
      assert: "storage-key-present",
      key: "token",
      equals: "abc",
    });
    expect(match.check.outcome).toBe("pass");
    const mismatch = await assertOnce({
      assert: "storage-key-present",
      key: "token",
      equals: "xyz",
    });
    expect(mismatch.check.outcome).toBe("fail");
  });

  it("is inconclusive over a frame shape it cannot read", async () => {
    liveSession();
    live.storageFrame = frameWith(["surprise"]);
    const { check } = await assertOnce({
      assert: "storage-key-present",
      key: "token",
    });
    expect(check.outcome).toBe("inconclusive");
  });
});

describe("console-errors-empty", () => {
  /* @invariant The flagship. Zero errors over a session that never wrote a
     line is "nothing happened", and an agent counting events in a payload
     cannot tell that from a clean run. */
  it("is inconclusive over an empty timeline instead of passing", async () => {
    liveSession();
    const { frame, check } = await assertOnce({
      assert: "console-errors-empty",
    });
    expect(check.outcome).toBe("inconclusive");
    expect(frame.ok).toBe(false);
  });

  it("names the broken session as the reason when there is no build", async () => {
    const { check } = await assertOnce({ assert: "console-errors-empty" });
    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toContain("no dev session has produced a build here");
  });

  it("is inconclusive when the file belongs to a past run", async () => {
    writeReady({
      status: "ready",
      pid: process.pid,
      runId: "run-9",
      instanceId: "inst-9",
    });
    writeLogs([
      { type: "header", runId: "run-1", v: 1 },
      { context: "popup", level: "info", seq: 1, message: "hi" },
    ]);
    const { check } = await assertOnce({ assert: "console-errors-empty" });
    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toContain("do not belong to a live run");
  });

  it("fails on error events and quotes them", async () => {
    liveSession();
    writeLogs([
      { type: "header", runId: "run-1", v: 1 },
      { context: "background", level: "error", seq: 1, message: "boom" },
      { context: "popup", level: "info", seq: 2, message: "fine" },
    ]);
    const { check } = await assertOnce({ assert: "console-errors-empty" });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toContain("boom");
  });

  it("passes on a live timeline with no error, and honours ignore", async () => {
    liveSession();
    writeLogs([
      { type: "header", runId: "run-1", v: 1 },
      { context: "popup", level: "info", seq: 1, message: "fine" },
    ]);
    const clean = await assertOnce({ assert: "console-errors-empty" });
    expect(clean.check.outcome).toBe("pass");

    writeLogs([
      { type: "header", runId: "run-1", v: 1 },
      {
        context: "background",
        level: "error",
        seq: 1,
        message: "ResizeObserver loop limit exceeded",
      },
    ]);
    const ignored = await assertOnce({
      assert: "console-errors-empty",
      ignore: ["ResizeObserver"],
    });
    expect(ignored.check.outcome).toBe("pass");
  });

  it("scopes to the contexts it was given", async () => {
    liveSession();
    writeLogs([
      { type: "header", runId: "run-1", v: 1 },
      { context: "content", level: "error", seq: 1, message: "page blew up" },
      { context: "background", level: "info", seq: 2, message: "fine" },
    ]);
    const scoped = await assertOnce({
      assert: "console-errors-empty",
      context: ["background"],
    });
    expect(scoped.check.outcome).toBe("pass");
    const unscoped = await assertOnce({ assert: "console-errors-empty" });
    expect(unscoped.check.outcome).toBe("fail");
  });
});

describe("the verdict document", () => {
  it("is a pass only when every check passed", async () => {
    writeManifest({ background: { service_worker: "sw.js" } });
    liveSession();
    writeLogs([
      { type: "header", runId: "run-1", v: 1 },
      { context: "background", level: "info", seq: 1, message: "booted" },
    ]);
    live.targets = [
      { id: "sw", type: "service_worker", url: `chrome-extension://${GUEST_ID}/sw.js` },
    ];
    const frame = JSON.parse(
      await handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "background-worker-booted" },
          { assert: "console-errors-empty" },
        ],
      }),
    );
    expect(frame.value.outcome).toBe("pass");
    expect(frame.value.passed).toBe(true);
    expect(frame.ok).toBe(true);
    expect(frame.value.contract).toBe("extension.dev/assert-verdict");
  });

  /* @invariant One inconclusive check sinks the run. If this ever reads pass,
     every honest refusal in this file has been converted into a green. */
  it("never reports a pass while a check is inconclusive", async () => {
    writeManifest({ background: { service_worker: "sw.js" } });
    liveSession();
    writeLogs([
      { type: "header", runId: "run-1", v: 1 },
      { context: "background", level: "info", seq: 1, message: "booted" },
    ]);
    live.targets = [
      { id: "sw", type: "service_worker", url: `chrome-extension://${GUEST_ID}/sw.js` },
    ];
    const frame = JSON.parse(
      await handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "background-worker-booted" },
          { assert: "content-script-injected", url: "https://shop.example/x" },
        ],
      }),
    );
    expect(frame.value.checks.map((c: { outcome: string }) => c.outcome)).toEqual([
      "pass",
      "inconclusive",
    ]);
    expect(frame.value.outcome).toBe("inconclusive");
    expect(frame.value.passed).toBe(false);
    expect(frame.ok).toBe(false);
    expect(frame.warnings.join(" ")).toContain("Inconclusive");
  });

  it("refuses a stage that states nothing", async () => {
    const frame = JSON.parse(
      await handler({ projectPath: project, browser: BROWSER, expect: [] }),
    );
    expect(frame.ok).toBe(false);
    expect(frame.error.message).toContain("cannot report a pass");
  });

  it("refuses two clauses that judge the same subject", async () => {
    const frame = JSON.parse(
      await handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "surface-rendered", surface: "popup" },
          { assert: "surface-rendered", surface: "popup" },
        ],
      }),
    );
    expect(frame.ok).toBe(false);
    expect(frame.error.message).toContain("undecidable");
  });

  it("judges the same check over two subjects in one run", async () => {
    writeManifest({
      action: { default_popup: "popup.html" },
      options_ui: { page: "options.html" },
    });
    liveSession();
    live.targets = [
      { id: "popup", type: "page", url: `chrome-extension://${GUEST_ID}/popup.html` },
    ];
    live.render = { readyState: "complete", bodyElementCount: 5, textLength: 9 };
    const frame = JSON.parse(
      await handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "surface-rendered", surface: "popup" },
          { assert: "surface-rendered", surface: "options" },
        ],
      }),
    );
    expect(frame.value.checks.map((c: { subject: string }) => c.subject)).toEqual([
      "popup",
      "options",
    ]);
    expect(frame.value.checks.map((c: { outcome: string }) => c.outcome)).toEqual([
      "pass",
      "fail",
    ]);
  });

  it("names the checks it knows when handed one it does not", async () => {
    const frame = JSON.parse(
      await handler({
        projectPath: project,
        browser: BROWSER,
        expect: [{ assert: "it-works" }],
      }),
    );
    expect(frame.ok).toBe(false);
    expect(frame.error.message).toContain("background-worker-booted");
  });
});

describe("match patterns decide wording, never a pass", () => {
  it("reads the grammar Chrome documents", () => {
    expect(matchPatternCovers("https://shop.example/*", "https://shop.example/cart")).toBe(true);
    expect(matchPatternCovers("*://shop.example/*", "http://shop.example/")).toBe(true);
    expect(matchPatternCovers("*://*.example/*", "https://a.b.example/x")).toBe(true);
    expect(matchPatternCovers("<all_urls>", "https://anything.test/")).toBe(true);
    expect(matchPatternCovers("https://shop.example/*", "https://evil.test/")).toBe(false);
    expect(matchPatternCovers("*://shop.example/*", "ftp://shop.example/")).toBe(false);
    expect(matchPatternCovers("https://shop.example/cart*", "https://shop.example/other")).toBe(false);
    expect(matchPatternCovers("https://*.example/*", "https://example.test/")).toBe(false);
  });

  it("names only the pages the browser refuses outright", () => {
    expect(contentScriptsForbidden("chrome://extensions/")).toContain("browser interface");
    expect(contentScriptsForbidden("https://chromewebstore.google.com/detail/x")).toContain("Web Store");
    expect(contentScriptsForbidden(`chrome-extension://${GUEST_ID}/popup.html`)).toContain("extension page");
    expect(contentScriptsForbidden("about:blank")).toBeNull();
    expect(contentScriptsForbidden("file:///tmp/x.html")).toBeNull();
    expect(contentScriptsForbidden("https://shop.example/")).toBeNull();
  });
});
