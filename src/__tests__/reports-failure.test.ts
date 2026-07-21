// FAILURE-REPORTING HARNESS
//
// Every other suite asks "does the tool work when things are fine". This one
// asks the question that actually bit us: WHEN THE UNDERLYING THING FAILED,
// DOES THE TOOL SAY SO?
//
// Motivation (2026-07-20): four separate false greens shipped or nearly
// shipped in one release cycle, doctor reported healthy over a crashing
// background, dev and start reported "started" for a process that had already
// exited, open reported ok:true for a navigation that 404'd, and build reported
// success for a dist missing a declared entrypoint. A 30-persona swarm found
// NONE of them, because a persona believes what a tool tells it. Only an
// adversarial assertion catches a lie.
//
// RULE FOR THIS FILE: break something real, then assert the tool reports the
// failure. Never assert on the happy path here. That is what the other suites
// are for. A test that passes because nothing was broken is worse than no test.
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-reports-failure-"));
  tmpDirs.push(dir);
  return dir;
}

function writeReady(
  projectPath: string,
  browser: string,
  contract: Record<string, unknown>,
): void {
  const dir = path.join(projectPath, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify(contract));
}

function writeLogs(
  projectPath: string,
  browser: string,
  events: Array<Record<string, unknown>>,
): void {
  const dir = path.join(projectPath, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "logs.ndjson"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

// A pid that cannot be alive, for "the session died" scenarios.
const DEAD_PID = 2 ** 30;

let cliResult = { code: 0, stdout: "", stderr: "" };
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    runExtensionCli: async () => cliResult,
  };
});

const doctor = await import("../tools/doctor");
const build = await import("../tools/build");
const waitTool = await import("../tools/wait");
const logs = await import("../tools/logs");
const { recentErrorLogs } = doctor;

afterEach(() => {
  cliResult = { code: 0, stdout: "", stderr: "" };
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("doctor reports failure when the extension is broken", () => {
  it("surfaces a crashing background instead of reporting healthy", () => {
    const project = tmpProject();
    writeLogs(project, "chrome", [
      {
        v: 1,
        level: "error",
        context: "background",
        messageParts: [
          "Uncaught TypeError: Cannot read properties of undefined (reading 'query')",
        ],
        runId: "r1",
      },
    ]);

    // The exact shape that used to be dropped: payload in messageParts.
    const errs = recentErrorLogs(project, "chrome");

    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("Uncaught TypeError");
  });

  it("does not invent errors when the extension is quiet", () => {
    const project = tmpProject();
    writeLogs(project, "chrome", [
      { v: 1, level: "info", context: "background", messageParts: ["ok"], runId: "r1" },
    ]);

    expect(recentErrorLogs(project, "chrome")).toEqual([]);
  });

  it("reports unhealthy when the ready contract records an error", async () => {
    const project = tmpProject();
    writeReady(project, "chrome", {
      status: "error",
      pid: process.pid,
      errors: ["Module not found: ./missing.js"],
    });
    cliResult = { code: 0, stdout: "[]", stderr: "" };

    const result = JSON.parse(
      await doctor.handler({ projectPath: project, browser: "chrome" }),
    );

    expect(result.healthy).toBe(false);
    const runtime = result.checks.find(
      (c: { check: string }) => c.check === "runtime-errors",
    );
    expect(runtime.status).toBe("fail");
    expect(runtime.detail).toContain("missing.js");
  });
});

describe("wait reports failure when the session is not actually usable", () => {
  it("reports stale, not ready, when ready.json outlives a dead dev server", async () => {
    const project = tmpProject();
    writeReady(project, "chrome", { status: "ready", pid: DEAD_PID });

    const result = JSON.parse(
      await waitTool.handler({ projectPath: project, browser: "chrome" }),
    );

    // The trap: status "ready" on disk while nothing is running.
    expect(result.status).not.toBe("ready");
    expect(result.status).toBe("stale");
    expect(result.message).toMatch(/exited|dead/i);
  });

  it("reports the recorded build error rather than waiting it out", async () => {
    const project = tmpProject();
    writeReady(project, "chrome", {
      status: "error",
      pid: process.pid,
      message: "compile failed",
    });

    const result = JSON.parse(
      await waitTool.handler({ projectPath: project, browser: "chrome" }),
    );

    expect(result.status).toBe("error");
  });
});

describe("build reports failure when the artifact is unusable", () => {
  function projectWithManifest(
    manifest: Record<string, unknown>,
    dist?: { manifest: Record<string, unknown>; files: string[] },
  ): string {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "manifest.json"),
      JSON.stringify(manifest),
    );
    if (dist) {
      const distDir = path.join(dir, "dist", "chrome");
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(
        path.join(distDir, "manifest.json"),
        JSON.stringify(dist.manifest),
      );
      for (const f of dist.files) {
        fs.writeFileSync(path.join(distDir, f), "x");
      }
    }
    return dir;
  }

  it("refuses a build whose manifest has build-blocking errors", async () => {
    // No name: a required field.
    const dir = projectWithManifest({ manifest_version: 3, version: "1.0.0" });

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.success).toBe(false);
    expect(result.status).toBe("blocked");
  });

  it("refuses to report success when a declared entrypoint never reached dist", async () => {
    // The SOURCE must be complete, so the manifest gate passes and we are
    // genuinely testing the dist-completeness path rather than tripping the
    // dangling-reference error first.
    const dir = projectWithManifest(
      {
        manifest_version: 3,
        name: "F",
        version: "1.0.0",
        action: { default_popup: "popup.html" },
      },
      { manifest: { action: { default_popup: "popup.html" } }, files: [] },
    );
    fs.writeFileSync(path.join(dir, "src", "popup.html"), "<html></html>");
    // The bundler is happy; the artifact is not loadable.
    cliResult = { code: 0, stdout: "Build Status: success", stderr: "" };

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.success).toBe(false);
    expect(result.status).toBe("incomplete");
    expect(result.buildExitCode).toBe(0);
  });

  it("propagates a non-zero build exit as a failure", async () => {
    const dir = projectWithManifest({
      manifest_version: 3,
      name: "F",
      version: "1.0.0",
    });
    cliResult = { code: 1, stdout: "", stderr: "Module not found: ./nope.js" };

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("nope.js");
  });
});

// Both cases below were found by the API-surface persona swarm (wave 1,
// 2026-07-20) and verified against the source before fixing.
describe("swarm-found lies stay fixed", () => {
  function projectWith(
    manifest: Record<string, unknown>,
    presentFiles: string[] = [],
  ): string {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "manifest.json"),
      JSON.stringify(manifest),
    );
    for (const f of presentFiles) {
      const full = path.join(dir, "src", f);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "x");
    }
    return dir;
  }

  // B6: an adblocker whose ruleset file is missing got valid:true while
  // extension_build failed NOT FOUND on the same tree.
  it("manifest_validate flags a missing declarativeNetRequest ruleset", async () => {
    const manifestValidate = await import("../tools/manifest-validate");
    const dir = projectWith({
      manifest_version: 3,
      name: "Adblocker",
      version: "1.0.0",
      permissions: ["declarativeNetRequest"],
      declarative_net_request: {
        rule_resources: [
          { id: "tracker", enabled: true, path: "rules/tracker-rules.json" },
        ],
      },
    });

    const result = JSON.parse(
      await manifestValidate.handler({ projectPath: dir, browsers: ["chrome"] }),
    );

    const text = JSON.stringify(result);
    expect(text).toContain("tracker-rules.json");
  });

  it("manifest_validate stays quiet when the ruleset is present", async () => {
    const manifestValidate = await import("../tools/manifest-validate");
    const dir = projectWith(
      {
        manifest_version: 3,
        name: "Adblocker",
        version: "1.0.0",
        permissions: ["declarativeNetRequest"],
        declarative_net_request: {
          rule_resources: [
            { id: "tracker", enabled: true, path: "rules/tracker-rules.json" },
          ],
        },
      },
      ["rules/tracker-rules.json"],
    );

    const result = JSON.parse(
      await manifestValidate.handler({ projectPath: dir, browsers: ["chrome"] }),
    );

    expect(JSON.stringify(result)).not.toContain("tracker-rules.json");
  });

  it("manifest_validate warns that a Chrome-only key is inert on the edge target", async () => {
    const manifestValidate = await import("../tools/manifest-validate");
    const dir = projectWith({
      manifest_version: 3,
      name: "Kiosk relay",
      version: "1.0.0",
      file_browser_handlers: [
        { id: "upload", default_title: "Relay", file_filters: ["*.json"] },
      ],
    });

    const edge = JSON.parse(
      await manifestValidate.handler({ projectPath: dir, browsers: ["edge"] }),
    );
    expect(edge.valid).toBe(true);
    expect(JSON.stringify(edge.warnings)).toMatch(/file_browser_handlers.*inert on Edge/);

    // Chrome must NOT warn: the key is native there.
    const chrome = JSON.parse(
      await manifestValidate.handler({ projectPath: dir, browsers: ["chrome"] }),
    );
    expect(JSON.stringify(chrome.warnings)).not.toContain("inert on Edge");
  });

  // A1: a devtools panel that never reached dist still reported
  // "ready for deployment", because devtools_page was outside the contract.
  it("build's completeness contract covers every declared surface", async () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "F", version: "1.0.0" }),
    );
    const distDir = path.join(dir, "dist", "chrome");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "manifest.json"),
      JSON.stringify({
        devtools_page: "devtools/panel.html",
        options_ui: { page: "options/index.html" },
        side_panel: { default_path: "panel/side.html" },
        chrome_url_overrides: { newtab: "newtab/index.html" },
      }),
    );
    cliResult = { code: 0, stdout: "Build Status: success", stderr: "" };

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.success).toBe(false);
    expect(result.status).toBe("incomplete");
    const missing = JSON.stringify(result.entrypoints);
    expect(missing).toContain("devtools_page");
    expect(missing).toContain("options_ui.page");
    expect(missing).toContain("side_panel.default_path");
    expect(missing).toContain("chrome_url_overrides.newtab");
  });
});

// L1: the most corroborated lie in the swarm (6 of 15 personas).
describe("manifest_validate verdicts are always explainable", () => {
  it("never returns valid:false with nothing in errors", async () => {
    const manifestValidate = await import("../tools/manifest-validate");
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    // A Chrome-targeted MV3 extension: Firefox support advisories must not
    // silently decide the headline when the caller never asked about Firefox.
    fs.writeFileSync(
      path.join(dir, "src", "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Chrome only",
        version: "1.0.0",
        background: { service_worker: "sw.js" },
      }),
    );
    fs.writeFileSync(path.join(dir, "src", "sw.js"), "");

    const result = JSON.parse(
      await manifestValidate.handler({ projectPath: dir }),
    );

    if (result.valid === false) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("keeps an unrequested target's advisory as a named warning", async () => {
    const manifestValidate = await import("../tools/manifest-validate");
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Chrome only",
        version: "1.0.0",
        background: { service_worker: "sw.js" },
      }),
    );
    fs.writeFileSync(path.join(dir, "src", "sw.js"), "");

    const result = JSON.parse(
      await manifestValidate.handler({ projectPath: dir }),
    );

    const unsupported = Object.entries(result.browserSupport || {}).filter(
      ([, v]: [string, any]) => !v.supported,
    );
    for (const [browser] of unsupported) {
      expect(JSON.stringify(result.warnings)).toContain(browser);
    }
  });

  it("makes an explicitly requested unsupported target an error", async () => {
    const manifestValidate = await import("../tools/manifest-validate");
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Chrome only",
        version: "1.0.0",
        background: { service_worker: "sw.js" },
      }),
    );
    fs.writeFileSync(path.join(dir, "src", "sw.js"), "");

    const result = JSON.parse(
      await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"] }),
    );

    if (result.browserSupport?.firefox?.supported === false) {
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.errors)).toContain("firefox");
    }
  });
});

// L8: "ready" meant COMPILED, not usable. B7 got ready in 4ms, then every
// control verb failed with "no executor connected".
describe("wait distinguishes compiled from usable", () => {
  it("does not report ready before the runtime executor attaches", async () => {
    const project = tmpProject();
    writeReady(project, "chrome", {
      status: "ready",
      pid: process.pid,
      browser: "chrome",
      // no runtime:"attached", no executorAttachedAt
    });

    const result = JSON.parse(
      await waitTool.handler({
        projectPath: project,
        browser: "chrome",
        timeout: 1000,
      }),
    );

    expect(result.status).not.toBe("ready");
    expect(result.status).toBe("compiled-not-attached");
    expect(result.message).toContain("no executor connected");
  }, 15_000);

  it("reports ready once the executor has attached", async () => {
    const project = tmpProject();
    writeReady(project, "chrome", {
      status: "ready",
      pid: process.pid,
      browser: "chrome",
      runtime: "attached",
      executorAttachedAt: "2026-07-20T12:00:00.000Z",
    });

    const result = JSON.parse(
      await waitTool.handler({
        projectPath: project,
        browser: "chrome",
        timeout: 3000,
      }),
    );

    expect(result.status).toBe("ready");
  }, 15_000);
});

// L2: a green production build that quietly lost permissions or
// web_accessible_resources relative to the source the developer tested.
describe("build reports what the production artifact lost", () => {
  it("flags dropped permissions and stripped web_accessible_resources", async () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "F",
        version: "1.0.0",
        permissions: ["storage", "tabs"],
        web_accessible_resources: [{ resources: ["inject.css"], matches: ["<all_urls>"] }],
      }),
    );
    const distDir = path.join(dir, "dist", "chrome");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "manifest.json"),
      JSON.stringify({ permissions: ["storage"] }),
    );
    cliResult = { code: 0, stdout: "Build Status: success", stderr: "" };

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    const divergence = JSON.stringify(result.productionDivergence);
    expect(divergence).toContain("tabs");
    expect(divergence).toContain("web_accessible_resources");
  });
});

describe("logs reports failure rather than empty success", () => {
  it("errors when there is no log file at all", async () => {
    const project = tmpProject();

    const result = JSON.parse(await logs.handler({ projectPath: project }));

    expect(result.error).toBeDefined();
    expect(result.error).toContain("No logs found");
  });

  it("distinguishes an empty log from a missing one", async () => {
    const project = tmpProject();
    writeLogs(project, "chrome", []);

    const result = JSON.parse(
      await logs.handler({ projectPath: project, browser: "chrome" }),
    );

    // Reading succeeded and nothing matched: count must make that legible
    // rather than implying the extension is silent-and-fine.
    if (result.ok) {
      expect(result.count).toBe(0);
    } else {
      expect(result.error).toBeDefined();
    }
  });
});

// WAVE-2 (API-surface swarm, clusters D/E/F) lies stay fixed. Same charter as
// above: every test breaks something real and asserts the tool SAYS SO.
describe("wave-2 swarm lies stay fixed", () => {
  it("manifest_validate reports per-target permission divergence (E25)", async () => {
    const manifestValidate = await import("../tools/manifest-validate");
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "manifest.json"),
      JSON.stringify({
        name: "proxy-switcher",
        version: "1.0.0",
        manifest_version: 3,
        "chromium:permissions": ["proxy"],
      }),
    );
    fs.writeFileSync(
      path.join(dir, "src", "background.js"),
      "chrome.proxy.settings.set({value: {mode: 'direct'}});\n",
    );

    const result = JSON.parse(
      await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"] }),
    );

    expect(result.valid).toBe(false);
    expect(result.browserSupport.firefox.supported).toBe(false);
    const all = [...result.errors, ...result.browserSupport.firefox.issues].join(" ");
    expect(all).toContain("proxy");
    expect(all).toContain("firefox");
  });

  it("manifest_validate rejects an impossible manifest_version (F27)", async () => {
    const manifestValidate = await import("../tools/manifest-validate");
    const dir = tmpProject();
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ name: "x", version: "1.0.0", manifest_version: 4 }),
    );

    const result = JSON.parse(
      await manifestValidate.handler({ projectPath: dir, browsers: ["chrome"] }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("manifest_version must be 2 or 3");
  });

  it("manifest_validate blocks a default_locale with no catalog (F29)", async () => {
    const manifestValidate = await import("../tools/manifest-validate");
    const dir = tmpProject();
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        name: "i18n-ext",
        version: "1.0.0",
        manifest_version: 3,
        default_locale: "en",
      }),
    );

    const result = JSON.parse(
      await manifestValidate.handler({ projectPath: dir, browsers: ["chrome"] }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("_locales/en/messages.json");
  });

  it("manifest_validate accepts a default_locale whose catalog exists", async () => {
    const manifestValidate = await import("../tools/manifest-validate");
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, "_locales", "en"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "_locales", "en", "messages.json"),
      JSON.stringify({ appName: { message: "ok" } }),
    );
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        name: "i18n-ext",
        version: "1.0.0",
        manifest_version: 3,
        default_locale: "en",
      }),
    );

    const result = JSON.parse(
      await manifestValidate.handler({ projectPath: dir, browsers: ["chrome"] }),
    );

    expect(result.errors.join(" ")).not.toContain("_locales");
  });

  it("manifest_validate warns when the 128px store icon is missing (F30)", async () => {
    const manifestValidate = await import("../tools/manifest-validate");
    const dir = tmpProject();
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        name: "store-bound",
        version: "1.0.0",
        manifest_version: 3,
        icons: { "16": "icon16.png", "48": "icon48.png" },
      }),
    );
    fs.writeFileSync(path.join(dir, "icon16.png"), "");
    fs.writeFileSync(path.join(dir, "icon48.png"), "");

    const result = JSON.parse(
      await manifestValidate.handler({ projectPath: dir, browsers: ["chrome"] }),
    );

    expect(result.warnings.join(" ")).toContain("128x128");
  });

  it("manifest_validate includes edge in the default target matrix (F28)", async () => {
    const manifestValidate = await import("../tools/manifest-validate");
    const dir = tmpProject();
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ name: "x", version: "1.0.0", manifest_version: 3 }),
    );

    const result = JSON.parse(
      await manifestValidate.handler({ projectPath: dir }),
    );

    expect(Object.keys(result.browserSupport)).toContain("edge");
  });

  it("logs marks events from a dead session as stale instead of serving them as live (D20)", async () => {
    const project = tmpProject();
    writeReady(project, "chrome", {
      status: "ready",
      pid: DEAD_PID,
      runId: "old-run",
    });
    const dir = path.join(project, "dist", "extension-js", "chrome");
    fs.writeFileSync(
      path.join(dir, "logs.ndjson"),
      [
        JSON.stringify({ type: "header", runId: "old-run" }),
        JSON.stringify({
          v: 1,
          level: "info",
          context: "background",
          messageParts: ["inventory refreshed"],
          runId: "old-run",
          seq: 1,
        }),
      ].join("\n") + "\n",
    );

    const result = JSON.parse(
      await logs.handler({ projectPath: project, browser: "chrome" }),
    );

    expect(result.matched).toBeGreaterThan(0);
    expect(result.stale).toBe(true);
    expect(result.warning).toContain("dead");
  });

  it("logs does not cry stale over a live session's own events", async () => {
    const project = tmpProject();
    writeReady(project, "chrome", {
      status: "ready",
      pid: process.pid,
      runId: "run-1",
    });
    const dir = path.join(project, "dist", "extension-js", "chrome");
    fs.writeFileSync(
      path.join(dir, "logs.ndjson"),
      [
        JSON.stringify({ type: "header", runId: "run-1" }),
        JSON.stringify({
          v: 1,
          level: "info",
          context: "background",
          messageParts: ["hello"],
          runId: "run-1",
          seq: 1,
        }),
      ].join("\n") + "\n",
    );

    const result = JSON.parse(
      await logs.handler({ projectPath: project, browser: "chrome" }),
    );

    expect(result.stale).toBeUndefined();
  });

  it("logs does not cry stale when events carry the session's instanceId", async () => {
    // Newer engine canaries stamp events with ready.json's instanceId rather
    // than its runId; a healthy live session must not be flagged stale.
    const project = tmpProject();
    writeReady(project, "chrome", {
      status: "ready",
      pid: process.pid,
      runId: "mrun-abc",
      instanceId: "7ba4c78fbbe50dc1",
    });
    const dir = path.join(project, "dist", "extension-js", "chrome");
    fs.writeFileSync(
      path.join(dir, "logs.ndjson"),
      [
        JSON.stringify({ type: "header", runId: "7ba4c78fbbe50dc1" }),
        JSON.stringify({
          v: 1,
          level: "info",
          context: "background",
          messageParts: ["hello"],
          runId: "7ba4c78fbbe50dc1",
          seq: 1,
        }),
      ].join("\n") + "\n",
    );

    const result = JSON.parse(
      await logs.handler({ projectPath: project, browser: "chrome" }),
    );

    expect(result.stale).toBeUndefined();
  });

  it("wait surfaces runtime errors instead of a bare ready over a crashed worker (E21)", async () => {
    const project = tmpProject();
    writeReady(project, "chrome", {
      status: "ready",
      pid: process.pid,
      runtime: "attached",
      browser: "chrome",
    });
    writeLogs(project, "chrome", [
      {
        v: 1,
        level: "error",
        context: "background",
        messageParts: ["Uncaught Error: boom at load\n    at service_worker.js:1"],
        runId: "r1",
      },
    ]);

    const result = JSON.parse(
      await waitTool.handler({ projectPath: project, browser: "chrome" }),
    );

    expect(result.status).toBe("ready");
    expect(result.runtimeErrors).toHaveLength(1);
    expect(result.runtimeErrors[0]).toContain("boom");
    expect(result.warning).toContain("throwing at runtime");
  });

  it("storage set without a key answers in MCP vocabulary, not CLI flags (E23/E24)", async () => {
    const storage = await import("../tools/storage");
    const project = tmpProject();

    const result = JSON.parse(
      await storage.handler({
        projectPath: project,
        action: "set",
        value: { a: 1, b: 2 },
      } as never),
    );

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("`key`");
    expect(result.error.message).toContain("one key per call");
    expect(result.error.message).not.toContain("--key");
  });
});

// Post-61-73 additions (2026-07-20): the canary closed the engine bugs, so the
// remaining lies live in how WE relay engine state. Same charter: break
// something real, assert the tool says so.
describe("act verbs report the dead session, not a config riddle", () => {
  it("eval's control error names the exited dev server when ready.json outlives it", async () => {
    const evalTool = await import("../tools/eval");
    const project = tmpProject();
    // The trap: a ready contract whose pid is dead. The engine's error text
    // asks "is the session started with allowControl?", which is a lie of
    // omission; nothing is running at all.
    writeReady(project, "chrome", { status: "ready", pid: DEAD_PID });
    cliResult = {
      code: 0,
      stdout: JSON.stringify({
        ok: false,
        error: {
          name: "ControlChannelError",
          message:
            "no executor connected: is the session started with allowControl?",
        },
      }),
      stderr: "",
    };

    const result = JSON.parse(
      await evalTool.handler({ projectPath: project, expression: "1+1" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("dev server has exited");
    expect(result.error.message).toContain("not an allowControl problem");
  });

  it("eval annotates an ambiguous null instead of asserting the engine is broken", async () => {
    const evalTool = await import("../tools/eval");
    const project = tmpProject();
    writeReady(project, "chrome", { status: "ready", pid: process.pid });
    cliResult = {
      code: 0,
      stdout: JSON.stringify({ ok: true, value: null }),
      stderr: "",
    };

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: project,
        expression: "void 0",
        context: "content",
      }),
    );

    // The old guard called content eval "known-broken in the current engine"
    // forever, steering callers off a path bug 61's fix repaired. The note must
    // be version-honest: trust the null on fixed engines, doubt it on old ones.
    expect(result.ok).toBe(true);
    expect(result.note).toContain(">= 4.0.14");
    expect(result.note).toContain("OLDER engines");
    expect(JSON.stringify(result)).not.toContain("known-broken");
  });

  it("eval leaves a real value un-annotated", async () => {
    const evalTool = await import("../tools/eval");
    const project = tmpProject();
    cliResult = {
      code: 0,
      stdout: JSON.stringify({ ok: true, value: 2 }),
      stderr: "",
    };

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: project,
        expression: "1+1",
        context: "content",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.note).toBeUndefined();
  });
});

describe("doctor names a dead browser instead of a generic build failure", () => {
  it("reads the engine's browser_exited stamp and prescribes the right remedy", async () => {
    const doctorTool = await import("../tools/doctor");
    const project = tmpProject();
    // The engine's bug-71/72 stamp: the CLI lives, the browser died.
    writeReady(project, "chrome", {
      status: "error",
      code: "browser_exited",
      browserExitCode: 9,
      browserExitedAt: "2026-07-20T12:00:00.000Z",
      pid: process.pid,
    });
    cliResult = { code: 0, stdout: "[]", stderr: "" };

    const result = JSON.parse(
      await doctorTool.handler({ projectPath: project, browser: "chrome" }),
    );

    expect(result.healthy).toBe(false);
    const runtime = result.checks.find(
      (c: { check: string }) => c.check === "runtime-errors",
    );
    expect(runtime.status).toBe("fail");
    expect(runtime.detail).toContain("browser");
    expect(runtime.detail).toContain("exit code 9");
    // The generic remedy ("fix the build error") would send the caller in
    // exactly the wrong direction; the build is fine, the browser is dead.
    expect(runtime.remediation).not.toContain("recompile");
    expect(runtime.remediation).toContain("extension_stop");
  });
});

describe("create verifies the scaffold instead of trusting the library", () => {
  it("reports incomplete when extension-create resolves over a manifest-less tree", async () => {
    vi.resetModules();
    const scaffoldDir = tmpProject();
    // Partial tree: package.json survived the interrupted download,
    // manifest.json did not.
    fs.writeFileSync(
      path.join(scaffoldDir, "package.json"),
      JSON.stringify({ name: "partial" }),
    );
    vi.doMock("extension-create", () => ({
      extensionCreate: async () => ({
        projectPath: scaffoldDir,
        projectName: "partial",
        template: "typescript",
        depsInstalled: false,
      }),
    }));
    const createTool = await import("../tools/create");

    const result = JSON.parse(
      await createTool.handler({ projectName: scaffoldDir } as never),
    );
    vi.doUnmock("extension-create");

    expect(result.ok).toBe(false);
    expect(result.status).toBe("incomplete");
    expect(result.error).toContain("manifest.json");
    // The lie we are guarding against: nextSteps pointing a caller at `run dev`
    // inside a tree that cannot compile.
    expect(result.nextSteps).toBeUndefined();
  });
});
