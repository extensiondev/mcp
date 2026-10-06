/* @invariant EACH CELL HERE FAILED BEFORE ITS FIX. Each guards against a tool that read "analyzed", "headless-clean", "pass",
 * "uninstalled" or "Safe to create" without reading the thing it was
 * describing. */

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let uninstallAnswer: unknown = [];
vi.mock("extension-install", () => ({
  extensionUninstall: vi.fn(async () => uninstallAnswer),
  extensionInstall: vi.fn(),
}));

const analyze = await import("../tools/analyze");
const themeVerify = await import("../tools/theme-verify");
const nodeEngine = await import("../lib/node-engine");
const uninstall = await import("../tools/uninstall-browser");
const addFeature = await import("../tools/add-feature");

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  uninstallAnswer = [];
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function distWith(files: Record<string, string>): string {
  const root = tmpDir("mcp-analyze-");
  const dist = path.join(root, "dist", "chrome");
  fs.mkdirSync(dist, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
    fs.writeFileSync(path.join(dist, rel), body);
  }
  return root;
}

describe("76: extension_analyze reads the dist before calling it analyzed", () => {
  it("refuses a corrupt manifest instead of analyzing an empty object", async () => {
    const root = distWith({ "manifest.json": "{", "background.js": "x" });
    const out = JSON.parse(await analyze.handler({ projectPath: root }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("dist-unreadable");
    expect(out.error.message).toMatch(/could not be parsed/);
  });

  it("refuses a dist with a manifest-less file set", async () => {
    const root = distWith({ "background.js": "x" });
    const out = JSON.parse(await analyze.handler({ projectPath: root }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("dist-unreadable");
    expect(out.error.message).toMatch(/does not exist/);
  });

  it("calls an empty dist nothing to analyze instead of passing every readiness flag", async () => {
    const root = tmpDir("mcp-analyze-");
    fs.mkdirSync(path.join(root, "dist", "chrome"), { recursive: true });
    const out = JSON.parse(await analyze.handler({ projectPath: root }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("dist-empty");
  });

  it("flags has128Icon only when the named icon file is in the dist", async () => {
    const manifest = JSON.stringify({ name: "x", version: "1.0", manifest_version: 3, icons: { "128": "icons/128.png" } });
    const named = distWith({ "manifest.json": manifest });
    const present = distWith({ "manifest.json": manifest, "icons/128.png": "png" });
    const a = JSON.parse(await analyze.handler({ projectPath: named }));
    const b = JSON.parse(await analyze.handler({ projectPath: present }));
    expect(a.value.storeReadiness.has128Icon).toBe(false);
    expect(b.value.storeReadiness.has128Icon).toBe(true);
  });

  it("keeps walking a directory past an entry it cannot stat", async () => {
    const root = distWith({
      "manifest.json": JSON.stringify({ name: "x", version: "1.0", manifest_version: 3 }),
      "assets/a.js": "a",
      "assets/z.js": "z",
    });
    fs.symlinkSync("/nowhere/at/all", path.join(root, "dist", "chrome", "assets", "m-broken"));
    const out = JSON.parse(await analyze.handler({ projectPath: root, format: "json" }));
    expect(out.ok).toBe(true);
    const paths = out.value.files.map((f: { path: string }) => f.path);
    expect(paths).toContain("assets/z.js");
    expect(paths).toContain("assets/m-broken");
    expect(out.value.files.find((f: { path: string }) => f.path === "assets/m-broken").type).toBe("unreadable");
    expect(out.warnings.join("\n")).toMatch(/assets\/m-broken/);
  });
});

describe("77: extension_theme_verify does not call a theme-less manifest clean", () => {
  const verify = (manifest: Record<string, unknown>) =>
    themeVerify.handler({ manifest }).then((s) => JSON.parse(s));

  it("answers no-theme for an ordinary extension manifest", async () => {
    const out = await verify({ name: "x", version: "1.0", manifest_version: 3 });
    expect(out.ok).toBe(false);
    expect(out.status).toBe("no-theme");
    expect(out.error.code).toBe("E_NO_THEME");
  });

  it("answers no-theme for a misspelled theme key", async () => {
    const out = await verify({ name: "x", version: "1.0", themes: { colors: { frame: [1, 2, 3] } } });
    expect(out.status).toBe("no-theme");
  });

  it("lists a malformed tint as a key Chrome throws away", async () => {
    const out = await verify({
      name: "x",
      version: "1.0",
      theme: { colors: { frame: [1, 2, 3] }, tints: { buttons: [0.5, 0.5], frame: ["red", 0, 0] } },
    });
    expect(out.status).toBe("diverged");
    const keys = out.value.findings.map((f: { key?: string }) => f.key);
    expect(keys).toContain("tints.buttons");
    expect(keys).toContain("tints.frame");
    const detail = out.value.findings.find((f: { key?: string }) => f.key === "tints.buttons").detail;
    expect(detail).toMatch(/tints\.buttons/);
    expect(detail).not.toMatch(/colors\./);
  });

  it("lists a non-numeric ntp_logo_alternate as ignored", async () => {
    const out = await verify({
      name: "x",
      version: "1.0",
      theme: { colors: { frame: [1, 2, 3] }, properties: { ntp_logo_alternate: "1" } },
    });
    const keys = out.value.findings.map((f: { key?: string }) => f.key);
    expect(keys).toContain("properties.ntp_logo_alternate");
  });

  it("lets ok follow an invalid verdict", async () => {
    const out = await verify({ name: "", version: "nope", theme: { colors: { frame: [1, 2, 3] } } });
    expect(out.status).toBe("invalid");
    expect(out.ok).toBe(false);
  });
});

describe("80b: the doctor's node leg reads the engine's declared floor", () => {
  it("reads the installed extension-develop engines.node, not a hardcoded 20", () => {
    const engine = nodeEngine.engineNodeRange();
    expect(engine).not.toBeNull();
    expect(engine!.range).toBe(">=22.12");
  });

  it("fails Node 20.18 against an engine that needs 22.12 and passes 22.12.0", () => {
    expect(nodeEngine.nodeCheck("20.18.0").status).toBe("fail");
    expect(nodeEngine.nodeCheck("22.11.9").status).toBe("fail");
    expect(nodeEngine.nodeCheck("22.12.0").status).toBe("pass");
    expect(nodeEngine.nodeCheck("24.1.0").status).toBe("pass");
    expect(nodeEngine.nodeCheck("20.18.0").remediation).toMatch(/>=22\.12/);
    expect(nodeEngine.nodeCheck("20.18.0").detail).toMatch(/extension-develop 4\./);
  });

  it("says when it cannot read a range instead of passing", () => {
    expect(nodeEngine.meetsNodeRange("22.12.0", "^20 || >=22")).toBeNull();
    expect(nodeEngine.meetsNodeRange("22.12.0", ">=22.12")).toBe(true);
    expect(nodeEngine.meetsNodeRange("v22.12.0", ">= 22.12.1")).toBe(false);
  });
});

describe("81a: extension_browsers uninstall reads the per-browser result", () => {
  it("says not-installed when the library removed nothing", async () => {
    uninstallAnswer = [{ browser: "chromium", removed: false, path: "/cache/chromium" }];
    const out = JSON.parse(await uninstall.uninstallManagedBrowser({ browser: "chromium" }));
    expect(out.status).toBe("not-installed");
    expect(out.value.removed).toEqual([]);
    expect(out.value.notInstalled).toEqual(["chromium"]);
    expect(out.hint).toMatch(/was not installed/);
  });

  it("says uninstalled only when every target was removed, partially otherwise", async () => {
    uninstallAnswer = [
      { browser: "chrome", removed: true, path: "/cache/chrome" },
      { browser: "firefox", removed: false, path: "/cache/firefox" },
    ];
    const partial = JSON.parse(await uninstall.uninstallManagedBrowser({ all: true }));
    expect(partial.status).toBe("uninstalled-partially");
    expect(partial.value.removed).toEqual(["chrome"]);
    uninstallAnswer = [{ browser: "chrome", removed: true, path: "/cache/chrome" }];
    const full = JSON.parse(await uninstall.uninstallManagedBrowser({ browser: "chrome" }));
    expect(full.status).toBe("uninstalled");
    expect(full.ok).toBe(true);
  });

  it("is unconfirmed when the library returned no rows", async () => {
    uninstallAnswer = undefined;
    const out = JSON.parse(await uninstall.uninstallManagedBrowser({ browser: "chrome" }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("uninstall-unconfirmed");
  });
});

describe("90b: extension_add_feature reads the manifest before saying safe", () => {
  function project(manifest: string): string {
    const root = tmpDir("mcp-addfeat-");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "manifest.json"), manifest);
    return root;
  }

  it("lists manifest keys the plan would replace, with or without a browser prefix", async () => {
    const root = project(JSON.stringify({ background: { service_worker: "bg.js" }, "chromium:side_panel": { default_path: "a.html" } }));
    const bg = JSON.parse(await addFeature.handler({ projectPath: root, feature: "background" }));
    expect(bg.status).toBe("planned-with-conflicts");
    expect(bg.value.manifestConflicts).toEqual(["background"]);
    expect(bg.hint).toBeUndefined();
    expect(bg.warnings.join("\n")).toMatch(/already declares background/);
    const side = JSON.parse(await addFeature.handler({ projectPath: root, feature: "sidebar", framework: "vanilla" }));
    expect(side.value.manifestConflicts).toContain("chromium:side_panel");
  });

  it("stays safe when the manifest declares none of the plan's keys", async () => {
    const root = project(JSON.stringify({ name: "x", version: "1.0", manifest_version: 3 }));
    const out = JSON.parse(await addFeature.handler({ projectPath: root, feature: "options" }));
    expect(out.status).toBe("planned");
    expect(out.value.manifestConflicts).toEqual([]);
    expect(out.hint).toMatch(/Safe to create/);
  });

  it("never says safe over a manifest it cannot parse", async () => {
    const root = project("{ not json");
    const out = JSON.parse(await addFeature.handler({ projectPath: root, feature: "options" }));
    expect(out.status).toBe("planned-with-conflicts");
    expect(out.value.manifestReadable).toBe(false);
    expect(out.hint).toBeUndefined();
    expect(out.warnings.join("\n")).toMatch(/could not be parsed/);
  });
});
