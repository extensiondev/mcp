import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reviewDistReport, reviewRisksReport, storeMdLine } from "../lib/store-review";

let dist: string;

function write(rel: string, content: string) {
  const file = path.join(dist, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function manifest(extra: Record<string, unknown>) {
  write("icons/128.png", "png");
  write("manifest.json", JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0", icons: { "128": "icons/128.png" }, ...extra }));
}

const codes = (browser = "chrome") => reviewDistReport(dist, browser).risks.map((r) => r.code);

beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-review-"));
});

afterEach(() => {
  fs.rmSync(dist, { recursive: true, force: true });
});

describe("reviewDistReport risks", () => {
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
    const risk = reviewDistReport(dist, "chrome").risks.find((r) => r.code === "REMOTE_CODE")!;
    expect(risk.message).toContain("eval()");
    expect(risk.message).toContain("importScripts from a URL");
    expect(risk.message).toContain("a <script> loaded from a URL");
    expect(risk.files).toEqual(expect.arrayContaining(["a.js", "b.js", "page.html"]));
  });

  it("asks a Firefox build for its data collection declaration, and only a Firefox build", () => {
    manifest({});
    expect(codes("firefox")).toContain("FIREFOX_DATA_COLLECTION_MISSING");
    expect(codes("chrome")).not.toContain("FIREFOX_DATA_COLLECTION_MISSING");

    const fix = reviewDistReport(dist, "firefox").risks.find((r) => r.code === "FIREFOX_DATA_COLLECTION_MISSING")?.fix ?? "";

    expect(fix).toContain("Ask the owner what the extension collects");
    expect(fix).toContain('{ "required": ["none"] } is the form only when they say it transmits no data');
    expect(fix).toContain("do not fill it in for them");

    manifest({
      browser_specific_settings: { gecko: { data_collection_permissions: { required: ["none"] } } },
    });

    expect(codes("firefox")).not.toContain("FIREFOX_DATA_COLLECTION_MISSING");
  });

  it("flags API permissions no shipped script uses, and leaves activeTab and hosts alone", () => {
    manifest({ permissions: ["storage", "tabs", "activeTab", "notifications"] });
    write("bg.js", "chrome.storage.sync.get(); browser.notifications.create('x', {});");
    const risk = reviewDistReport(dist, "chrome").risks.find((r) => r.code === "UNUSED_PERMISSION")!;
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

  it("names the enterprise channel of a Firefox package whose manifest sets admin_install_only true (ledger 511)", () => {
    manifest({ browser_specific_settings: { gecko: { id: "x@example.com", data_collection_permissions: { required: ["none"] }, admin_install_only: true } } });
    const risk = reviewDistReport(dist, "firefox").risks.find((r) => r.code === "FIREFOX_ENTERPRISE_CHANNEL")!;

    expect(risk.message).toContain("from December 1, 2026");
    expect(risk.message).toContain("neither listed nor unlisted");
    expect(risk.fix).toContain("remove it and build again");
    expect(codes("chrome")).not.toContain("FIREFOX_ENTERPRISE_CHANNEL");

    manifest({ browser_specific_settings: { gecko: { id: "x@example.com", data_collection_permissions: { required: ["none"] } } } });
    expect(codes("firefox")).not.toContain("FIREFOX_ENTERPRISE_CHANNEL");
  });

  it("919: names a 128 pixel icon the manifest does not declare, or whose file the build lacks, with the fix", () => {
    manifest({ icons: { "16": "icons/16.png" } });

    const undeclared = reviewDistReport(dist, "chrome").risks.find((r) => r.code === "ICON_128_MISSING")!;

    expect(undeclared.message).toContain('no 128x128 icon ("128" in icons)');
    expect(undeclared.message).toContain("Chrome Web Store requires one");
    expect(undeclared.fix).toBe('Add a 128x128 PNG to the project, declare it as "icons": { "128": "<path>" } in the manifest and build again.');

    manifest({ icons: { "128": "./images/gone.png" } });

    const gone = reviewDistReport(dist, "firefox").risks.find((r) => r.code === "ICON_128_MISSING")!;

    expect(gone.message).toContain('icons["128"] names images/gone.png, which is not in the build');
    expect(gone.fix).toBe(undeclared.fix);

    manifest({ icons: { "128": "/icons/128.png" } });
    expect(codes()).not.toContain("ICON_128_MISSING");
  });
});

describe("919: storeMdLine says where the permission justifications go", () => {
  const risk = { code: "BROAD_HOST_ACCESS" as const, message: "m", fix: "f" };

  it("says to write STORE.md at a root that has none, names the bullet for each declared permission, host permission and content script match, and leaves data use to the owner", () => {
    const line = storeMdLine(dist, [])!;

    expect(line).toBe(
      `No STORE.md is in ${dist}. Before a store submission, write it there, with a "### Permissions justification" bullet under "## Chrome Web Store" for each permission, host permission and content script match the manifest declares (extension_docs_search with "STORE.md" answers the rest); ask the owner for its data-use and privacy answers.`,
    );

    expect(line).not.toMatch(/none|collects nothing|no data/i);
  });

  it("says to check the bullets of a STORE.md that is there when the build has review risks, and nothing when it has none", () => {
    write("STORE.md", "# Store metadata\n");

    expect(storeMdLine(dist, [])).toBeNull();
    expect(storeMdLine(dist, [risk])).toBe(
      'STORE.md: check that a "### Permissions justification" bullet under "## Chrome Web Store" covers each permission, host permission and content script match the manifest declares.',
    );
  });
});
