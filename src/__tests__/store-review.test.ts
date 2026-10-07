import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reviewDist, reviewDistReport, reviewRisksReport } from "../lib/store-review";

let dist: string;

function write(rel: string, content: string) {
  const file = path.join(dist, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function manifest(extra: Record<string, unknown>) {
  write("manifest.json", JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0", ...extra }));
}

const codes = (browser = "chrome") => reviewDist(dist, browser).map((r) => r.code);

beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-review-"));
});

afterEach(() => {
  fs.rmSync(dist, { recursive: true, force: true });
});

describe("reviewDist", () => {
  it("finds nothing in a narrow, self-contained package", () => {
    manifest({
      permissions: ["storage"],
      host_permissions: ["https://example.com/*"],
      background: { service_worker: "background.js" },
    });

    write("background.js", "chrome.storage.local.set({ a: 1 });");
    expect(codes()).toEqual([]);
  });

  it("flags access to every site, from host permissions or content script matches", () => {
    manifest({ host_permissions: ["<all_urls>"] });
    expect(codes()).toContain("BROAD_HOST_ACCESS");
    manifest({ content_scripts: [{ matches: ["*://*/*"], js: ["c.js"] }] });
    write("c.js", "document.body;");
    expect(codes()).toContain("BROAD_HOST_ACCESS");
  });

  it("flags code the package did not ship", () => {
    manifest({});
    write("a.js", "const run = (s) => eval(s);");
    write("b.js", 'importScripts("https://cdn.example.com/x.js");');
    write("page.html", '<script src="https://cdn.example.com/y.js"></script>');
    const risk = reviewDist(dist, "chrome").find((r) => r.code === "REMOTE_CODE")!;
    expect(risk.message).toContain("eval()");
    expect(risk.message).toContain("importScripts from a URL");
    expect(risk.message).toContain("a <script> loaded from a URL");
    expect(risk.files).toEqual(expect.arrayContaining(["a.js", "b.js", "page.html"]));
  });

  it("asks a Firefox build for its data collection declaration, and only a Firefox build", () => {
    manifest({});
    expect(codes("firefox")).toContain("FIREFOX_DATA_COLLECTION_MISSING");
    expect(codes("chrome")).not.toContain("FIREFOX_DATA_COLLECTION_MISSING");
    manifest({
      browser_specific_settings: { gecko: { data_collection_permissions: { required: ["none"] } } },
    });

    expect(codes("firefox")).not.toContain("FIREFOX_DATA_COLLECTION_MISSING");
  });

  it("flags API permissions no shipped script uses, and leaves activeTab and hosts alone", () => {
    manifest({ permissions: ["storage", "tabs", "activeTab", "notifications"] });
    write("bg.js", "chrome.storage.sync.get(); browser.notifications.create('x', {});");
    const risk = reviewDist(dist, "chrome").find((r) => r.code === "UNUSED_PERMISSION")!;
    expect(risk.permissions).toEqual(["tabs"]);
  });

  it("judges only the manifest on a dev build", () => {
    manifest({ permissions: ["management"], host_permissions: ["<all_urls>"] });
    write("bg.js", "eval(x)");
    write("bg.a1b2.hot-update.js", "{}");
    expect(codes()).toEqual(["BROAD_HOST_ACCESS"]);
  });

  it("returns nothing for a folder without a manifest, and says the manifest was the reason", () => {
    write("a.js", "eval(x)");
    expect(codes()).toEqual([]);
    expect(reviewDistReport(dist, "chrome").manifestUnreadable).toMatch(/ENOENT|no such file/);
  });

  it("never calls a permission unused when a shipped script could not be read", () => {
    const report = reviewRisksReport({
      distPath: dist,
      browser: "chrome",
      manifest: { manifest_version: 3, name: "x", version: "1.0.0", permissions: ["storage"] },
      files: [{ path: "missing.js" }, { path: "page.html" }],
    });
    expect(report.unreadable).toEqual(["missing.js", "page.html"]);
    expect(report.risks.map((r) => r.code)).not.toContain("UNUSED_PERMISSION");
  });

  it("reports a permission unused only on a complete read", () => {
    manifest({ permissions: ["storage"] });
    write("bg.js", "console.log(1)");
    const report = reviewDistReport(dist, "chrome");
    expect(report.unreadable).toEqual([]);
    expect(report.notScanned).toEqual([]);
    expect(report.risks.map((r) => r.code)).toContain("UNUSED_PERMISSION");
  });
});
