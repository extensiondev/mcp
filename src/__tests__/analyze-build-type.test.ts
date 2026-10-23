import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handler as analyze } from "../tools/analyze";

const MANIFEST = { manifest_version: 3, name: "Leon", version: "1.0.0" };

const dirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-analyze-build-type-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify(MANIFEST));

  return dir;
}

function dist(dir: string, folder: string, manifest: Record<string, unknown> = MANIFEST): string {
  const out = path.join(dir, "dist", folder);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest));

  return out;
}

function write(root: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

function devDist(dir: string, browser: string): string {
  const out = dist(dir, browser, {
    ...MANIFEST,
    permissions: ["scripting", "tabs", "storage"],
    host_permissions: ["<all_urls>"],
    background: { service_worker: "background/service_worker.js" },
    content_scripts: [{ matches: ["<all_urls>"], js: ["content_scripts/dev-stub-0.js"] }],
  });
  write(out, "background/service_worker.js", "eval(x)");
  write(out, "background/service_worker.js.map", "{}");
  write(out, "content_scripts/dev-stub-0.js", "chrome.runtime.sendMessage({__extjsDevCsStub: 0})");
  write(out, "content_scripts/content-0.js", "eval(y)");
  write(out, "extension-js-control.json", JSON.stringify({ port: 43121, instanceId: "abc" }));
  fs.mkdirSync(path.join(out, "hot"), { recursive: true });

  return out;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_analyze tells a development build from a production one", () => {
  it("answers development, skips the store checks and names extension_build for the dist extension_dev wrote", async () => {
    const dir = project();
    devDist(dir, "edge");

    const out = JSON.parse(await analyze({ projectPath: dir, browser: "edge" }));

    expect(out.ok).toBe(true);
    expect(out.value.buildType).toBe("development");
    expect(out.value.buildTypeSource).toBe("markers");
    expect(out.value.buildTypeMarkers).toEqual([
      "extension-js-control.json at the dist root",
      "a dev content-script stub",
      "the hot/ folder",
    ]);

    expect(out.value.reviewRisks).toBeNull();
    expect(out.value.reviewCoverage).toBeNull();
    expect(out.value.storeReadiness).toBeNull();
    expect(out.value.note).toMatch(/^dist\/edge is a development build \(/);
    expect(out.value.note).toContain("store checks (review risks, sourcemaps, store readiness) are skipped for a development build");
    expect(out.value.note).toContain('extension_build with browser: "edge" produces the build to analyze');
    expect(out.hint).toBe(out.value.note);
    expect(out.value.nextStep).toEqual({
      tool: "extension_build",
      browser: "edge",
      say: 'Run extension_build with browser: "edge", then extension_analyze again.',
    });

    expect(out.warnings.join("\n")).not.toMatch(/Store review:|sourcemaps; they ship/);
    expect(out.value.manifestByBrowser.browsers).toEqual(["edge"]);
  });

  it("still answers production with its review risks and the sourcemap sentence for a real build", async () => {
    const dir = project();
    const out = dist(dir, "chrome", { ...MANIFEST, background: { service_worker: "bg.js" } });
    write(out, "bg.js", "eval(x)");
    write(out, "bg.js.map", "{}");

    const answer = JSON.parse(await analyze({ projectPath: dir }));

    expect(answer.value.buildType).toBe("production");
    expect(answer.value.buildTypeMarkers).toEqual([]);
    expect(answer.value.reviewRisks.map((r: { code: string }) => r.code)).toContain("REMOTE_CODE");
    expect(answer.value.storeReadiness.noSourceMaps).toBe(false);
    expect(answer.value.note).toBeUndefined();
    expect(answer.value.nextStep).toBeUndefined();
    expect(answer.warnings.join("\n")).toMatch(/sourcemaps; they ship unless the build strips them/);
  });

  it("reads production from a dist whose only oddity is its .map files", async () => {
    const dir = project();
    const out = dist(dir, "chrome");
    write(out, "bg.js", "console.log(1)");
    write(out, "bg.js.map", "{}");
    write(out, "popup/index.js.map", "{}");
    write(out, "popup/index.css.map", "{}");

    const answer = JSON.parse(await analyze({ projectPath: dir }));

    expect(answer.value.buildType).toBe("production");
    expect(answer.value.buildTypeSource).toBe("markers");
    expect(answer.value.reviewRisks).toEqual([]);
  });

  it("reads the hot/ folder as a marker even before the first hot update lands in it", async () => {
    const dir = project();
    const out = dist(dir, "chrome");
    write(out, "bg.js", "console.log(1)");
    fs.mkdirSync(path.join(out, "hot"), { recursive: true });

    const answer = JSON.parse(await analyze({ projectPath: dir }));

    expect(answer.value.buildType).toBe("development");
    expect(answer.value.buildTypeMarkers).toEqual(["the hot/ folder"]);
  });

  it("takes the engine's buildType from extension-js-control.json over the markers", async () => {
    const dir = project();
    const out = devDist(dir, "chrome");
    write(out, "extension-js-control.json", JSON.stringify({ port: 1, instanceId: "a", buildType: "production" }));

    const answer = JSON.parse(await analyze({ projectPath: dir }));

    expect(answer.value.buildType).toBe("production");
    expect(answer.value.buildTypeSource).toBe("engine");
    expect(answer.value.buildTypeMarkers).toEqual(["extension-js-control.json buildType"]);
    expect(Array.isArray(answer.value.reviewRisks)).toBe(true);

    write(out, "extension-js-control.json", JSON.stringify({ port: 1, instanceId: "a", buildType: "nonsense" }));
    const fallback = JSON.parse(await analyze({ projectPath: dir }));

    expect(fallback.value.buildType).toBe("development");
    expect(fallback.value.buildTypeSource).toBe("markers");
  });
});

describe("extension_analyze lists only the engine's browser names under manifestByBrowser", () => {
  it("names the project's test copies under otherFolders and never as browsers", async () => {
    const dir = project();
    dist(dir, "chrome");
    dist(dir, "firefox");
    dist(dir, "gecko-based");

    for (const copy of ["chrome-dev-assets", "chrome-test-host", "chrome-license", "firefox-test-host"]) {
      dist(dir, copy, { ...MANIFEST, name: `copy ${copy}`, permissions: ["management"] });
    }

    fs.mkdirSync(path.join(dir, "dist", "extension-js", "chrome"), { recursive: true });
    fs.mkdirSync(path.join(dir, "dist", "scratch"), { recursive: true });

    const out = JSON.parse(await analyze({ projectPath: dir }));
    const byBrowser = out.value.manifestByBrowser;

    expect(byBrowser.browsers).toEqual(["chrome", "firefox", "gecko-based"]);
    expect(byBrowser.otherFolders).toEqual([
      "chrome-dev-assets",
      "chrome-license",
      "chrome-test-host",
      "firefox-test-host",
      "scratch",
    ]);

    expect(Object.keys(byBrowser.emitted)).toEqual(["chrome", "firefox", "gecko-based"]);
    expect(Object.keys(byBrowser.resolved)).toEqual(["chrome", "firefox", "gecko-based"]);
    expect(byBrowser.differences).toEqual([]);
  });

  it("answers an empty otherFolders when dist holds browsers alone", async () => {
    const dir = project();
    dist(dir, "chrome");

    const out = JSON.parse(await analyze({ projectPath: dir }));

    expect(out.value.manifestByBrowser.otherFolders).toEqual([]);
  });
});
