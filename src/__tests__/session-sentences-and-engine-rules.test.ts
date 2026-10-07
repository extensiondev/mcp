/* @invariant session tools say what they
 * observed, stop-all keeps to this server's sessions, and build, analyze and
 * the review scan follow the engine's own rules. Each cell failed before
 * its fix. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { registerSession, removeSession, readSessionMarkers, sessionStateDir } from "../lib/process-manager";
import { handler as stop } from "../tools/stop";
import { TOOL_POLICY } from "../lib/tool-policy";
import { contractControlState } from "../lib/session-browser";
import { LAUNCH_FLAG_SCHEMA } from "../lib/launch-flags";
import { SERVER_INSTRUCTIONS } from "../index";
import { schema as browsersSchema } from "../tools/browsers";
import { detectBrowsers } from "../tools/detect-browsers";
import { BUNDLE_ID_PATTERN } from "../tools/build";
import { isDevelopmentBuild, reviewRisksReport } from "../lib/store-review";
import { handler as analyze } from "../tools/analyze";
import { manifestCandidates } from "../lib/project-manifest";
import { engineBrowserName } from "../lib/browser-family";
import { handler as themeVerify } from "../tools/theme-verify";
import { writeModernContract } from "./fixtures/ready-contract";

const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);

  return dir;
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ["EXTENSION_MCP_SESSION_DIR", "EXT_BROWSERS_CACHE_DIR"]) saved[key] = process.env[key];
  process.env.EXTENSION_MCP_SESSION_DIR = tmpDir("mcp-sessions-");
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("107a: stop all keeps to this server's sessions", () => {
  it("writes the owning server into every marker", () => {
    const project = tmpDir("mcp-proj-");
    registerSession({ pid: process.pid, browser: "chrome", projectPath: project, command: "dev" });

    try {
      const marker = readSessionMarkers().markers.find((m) => path.resolve(m.projectPath) === path.resolve(project));
      expect(marker?.serverPid).toBe(process.pid);
    } finally {
      removeSession(project, "chrome");
    }
  });

  it("leaves a marker owned by another running server alone unless asked", async () => {
    const dir = sessionStateDir();
    fs.mkdirSync(dir, { recursive: true });
    const project = tmpDir("mcp-foreign-proj-");
    fs.writeFileSync(
      path.join(dir, "foreign.json"),
      JSON.stringify({ pid: 999_999, browser: "chrome", projectPath: project, command: "dev", serverPid: process.ppid, registeredAt: new Date().toISOString() }),
    );

    const out = JSON.parse(await stop({ all: true } as never));
    expect(out.value.skippedForeign).toEqual([{ projectPath: project, browser: "chrome", serverPid: process.ppid }]);
    expect(out.warnings.join("\n")).toMatch(/other MCP servers that are still running/);

    const forced = JSON.parse(await stop({ all: true, includeOtherServers: true } as never));
    expect(forced.value.skippedForeign).toBeUndefined();
  });

  it("marks stop and auth destructive", () => {
    expect(TOOL_POLICY.extension_stop.annotations.destructiveHint).toBe(true);
    expect(TOOL_POLICY.extension_auth.annotations.destructiveHint).toBe(true);
  });
});

describe("107b: the control channel is read from the contract", () => {
  it("reports a control port the engine could not bind, with its reason", () => {
    const project = tmpDir("mcp-control-");
    const since = Date.now() - 1000;
    writeModernContract(project, "chrome", { controlPort: null, controlPortUnavailableReason: "EADDRINUSE 43210" });
    expect(contractControlState(project, "chrome", since)).toEqual({ read: true, port: null, unavailableReason: "EADDRINUSE 43210" });
    writeModernContract(project, "chrome", { controlPort: 43210 });
    expect(contractControlState(project, "chrome", since)).toEqual({ read: true, port: 43210, unavailableReason: null });
  });
});

describe("107 sentences", () => {
  it("binary inputs, the instructions and the install size say what the code does", () => {
    const flags = LAUNCH_FLAG_SCHEMA as Record<string, { description: string }>;
    expect(flags.chromiumBinary.description).not.toMatch(/overrides browser/);
    expect(flags.chromiumBinary.description).toMatch(/still names the target family/);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/already holds the session's debug port/);
    expect(SERVER_INSTRUCTIONS).toMatch(/ready\.json contract on each call/);
    expect(browsersSchema.description).not.toMatch(/580 to 625 MB/);
  });

  it("says where it looked when a browser is not found", async () => {
    process.env.EXT_BROWSERS_CACHE_DIR = tmpDir("mcp-cache-");
    const out = JSON.parse(await detectBrowsers(["yandex"]));
    const row = out.value.detected.find((d: { browser: string }) => d.browser === "yandex");

    if (row.source === "not_found") {
      expect(out.hint).toMatch(/Not found at the paths this server checks/);
      expect(out.hint).not.toMatch(/^Missing browser/);
    }
  }, 20_000);
});

describe("108: the engine's rules", () => {
  it("accepts every bundle id the engine accepts", () => {
    expect(BUNDLE_ID_PATTERN.test("abc")).toBe(true);
    expect(BUNDLE_ID_PATTERN.test("1a.b-c")).toBe(true);
    expect(BUNDLE_ID_PATTERN.test("com.acme.readinglist")).toBe(true);
    expect(BUNDLE_ID_PATTERN.test("a..b")).toBe(false);
    expect(BUNDLE_ID_PATTERN.test("a.")).toBe(false);
  });

  it("does not switch the review off over a source map, only over the dev runtime", () => {
    expect(isDevelopmentBuild([{ path: "bg.js" }, { path: "bg.js.map" }])).toBe(false);
    expect(isDevelopmentBuild([{ path: "bg.js" }, { path: "bg.abc.hot-update.js" }])).toBe(true);
    expect(isDevelopmentBuild([{ path: "extension-js/devtools.js" }])).toBe(true);
    const dist = tmpDir("mcp-review-");
    fs.writeFileSync(path.join(dist, "bg.js"), "eval(x)");
    fs.writeFileSync(path.join(dist, "bg.js.map"), "{}");
    const report = reviewRisksReport({ distPath: dist, browser: "chrome", manifest: { manifest_version: 3 }, files: [{ path: "bg.js" }, { path: "bg.js.map" }] });
    expect(report.risks.map((r) => r.code)).toContain("REMOTE_CODE");
  });

  it("knows the permissions a manifest key uses without a script call", () => {
    const dist = tmpDir("mcp-review-");
    fs.writeFileSync(path.join(dist, "bg.js"), "console.log(1)");
    const report = reviewRisksReport({
      distPath: dist,
      browser: "chrome",
      manifest: {
        manifest_version: 3,
        permissions: ["sidePanel", "declarativeNetRequest", "storage"],
        side_panel: { default_path: "panel.html" },
        declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path: "rules.json" }] },
      },
      files: [{ path: "bg.js" }],
    });
    const unused = report.risks.find((r) => r.code === "UNUSED_PERMISSION");
    expect(unused?.permissions).toEqual(["storage"]);
  });

  it("calls a dist with source maps a production build and says the maps ship", async () => {
    const root = tmpDir("mcp-analyze-");
    const dist = path.join(root, "dist", "chrome");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ name: "x", version: "1.0", manifest_version: 3 }));
    fs.writeFileSync(path.join(dist, "bg.js"), "eval(x)");
    fs.writeFileSync(path.join(dist, "bg.js.map"), "{}");
    const out = JSON.parse(await analyze({ projectPath: root }));
    expect(out.value.buildType).toBe("production");
    expect(out.warnings.join("\n")).toMatch(/sourcemaps; they ship unless the build strips them/);
    expect(out.value.reviewRisks.map((r: { code: string }) => r.code)).toContain("REMOTE_CODE");
  });

  it("reads firefox-based from the gecko-based dist the engine writes", () => {
    expect(engineBrowserName("firefox-based")).toBe("gecko-based");
    expect(engineBrowserName("firefox")).toBe("firefox");
    const candidates = manifestCandidates("/p", "firefox-based");
    expect(candidates.some((c) => c.includes(path.join("dist", "gecko-based", "manifest.json")))).toBe(true);
    expect(candidates.some((c) => c.includes(path.join("dist", "firefox-based")))).toBe(false);
  });

  it("does not call a theme with image-derived colours headless-clean", async () => {
    const out = JSON.parse(
      await themeVerify({ manifest: { name: "T", version: "1.0", theme: { colors: { frame: [1, 2, 3] }, images: { theme_frame: "frame.png" } } } }),
    );
    expect(out.status).toBe("headless-partial");
    expect(out.value.legs.chromePaints.resolver.detail).toMatch(/not a live Chrome read/);
    expect(out.value.legs.chromePaints.resolver.detail).not.toMatch(/every color current stable Chrome/);
  });
});
