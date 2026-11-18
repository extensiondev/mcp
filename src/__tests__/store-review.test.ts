import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { STORE_SECTIONS, SUBSECTION_KEYS } from "../lib/store-md-declarations";
import { reviewDistReport, reviewRisksReport, storeMdLine } from "../lib/store-review";

let dist: string;

const PNG_128 = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.from([0, 0, 0, 128, 0, 0, 0, 128, 8, 6, 0, 0, 0])]);

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
    expect(fix).toContain("with the categories they state");
    expect(fix).toContain("https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/");
    expect(fix).toContain("Do not fill it in for them or suggest a value. This rule is about the declaration alone.");
    expect(fix).not.toMatch(/gecko\.id\b|add-on ID/);

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

  it("920: no review risk message or fix suggests a value for the data collection declaration", () => {
    write("icons/16.png", "png");
    write("bg.js", "const run = (s) => eval(s);");
    write(
      "manifest.json",
      JSON.stringify({
        manifest_version: 3,
        name: "x",
        version: "1.0.0",
        icons: { "16": "icons/16.png" },
        permissions: ["tabs"],
        host_permissions: ["<all_urls>"],
        browser_specific_settings: { gecko: { id: "x@example.com", admin_install_only: true } },
      }),
    );

    const risks = reviewDistReport(dist, "firefox").risks;

    expect(risks.map((r) => r.code).sort()).toEqual([
      "BROAD_HOST_ACCESS",
      "FIREFOX_DATA_COLLECTION_MISSING",
      "FIREFOX_ENTERPRISE_CHANNEL",
      "ICON_128_MISSING",
      "REMOTE_CODE",
      "UNUSED_PERMISSION",
    ]);

    for (const risk of risks) {
      expect(`${risk.message} ${risk.fix}`).not.toMatch(/\bnone\b|"required"|transmits no data|collects nothing|collects no /i);
    }
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

  it("names the 128 pixel PNG already under the manifest's folder to declare, and a placeholder to save and report when none is there", () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-review-src-"));
    const sourceManifest = path.join(source, "src", "manifest.json");
    const fixOf = () => reviewDistReport(dist, "chrome", sourceManifest).risks.find((r) => r.code === "ICON_128_MISSING")!.fix;

    fs.mkdirSync(path.join(source, "src", "images"), { recursive: true });
    fs.mkdirSync(path.join(source, "src", "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(sourceManifest, "{}");
    fs.writeFileSync(path.join(source, "src", "node_modules", "dep", "logo.png"), PNG_128);
    fs.writeFileSync(path.join(source, "src", "images", "small.png"), "png");
    manifest({ icons: { "16": "icons/16.png" } });

    expect(fixOf()).toBe(
      'No 128x128 PNG is under the manifest\'s folder, and the artwork is the owner\'s. Until they supply it, save a plain placeholder PNG there as icons/icon-128.png, add "icons": { "128": "icons/icon-128.png" } to the manifest, build again and tell the owner it is a placeholder to replace before submitting.',
    );

    manifest({ icons: { "128": "./images/gone.png" } });

    expect(fixOf()).toBe(
      "No 128x128 PNG is under the manifest's folder, and the artwork is the owner's. Until they supply it, save a plain placeholder PNG there as images/gone.png, build again and tell the owner it is a placeholder to replace before submitting.",
    );

    fs.writeFileSync(path.join(source, "src", "images", "logo.png"), PNG_128);
    manifest({ icons: { "16": "icons/16.png" } });

    expect(fixOf()).toBe('images/logo.png under the manifest\'s folder is 128x128: add "icons": { "128": "images/logo.png" } to the manifest and build again.');

    fs.rmSync(source, { recursive: true, force: true });
  });
});

describe("919: storeMdLine says where the permission justifications go", () => {
  const risk = { code: "BROAD_HOST_ACCESS" as const, message: "m", fix: "f" };

  it("says to write STORE.md at a root that has none, names the Chrome, Firefox and Edge sections, the bullet for each declared permission, host permission and content script match and the Firefox reviewer notes, and leaves data use to the owner", () => {
    const line = storeMdLine(dist, [])!;

    expect(line).toBe(
      `No STORE.md is in ${dist}. Write it there now from the manifest and the code, one section per store: ## Chrome Web Store with a ### Permissions justification bullet per declared permission, host permission and content script match, ## Firefox Add-ons with ### Reviewer notes, ## Edge Add-ons (extension_docs_search "STORE.md" has the rest). Leave only its data-use and privacy rows unanswered for the owner, and show them what the code stores and sends.`,
    );

    expect(line).not.toMatch(/before a store submission|ask the owner for/i);

    for (const store of ["chrome", "firefox", "edge"] as const) expect(line).toContain(STORE_SECTIONS[store]);

    expect(line).toContain(`${STORE_SECTIONS.firefox} with ${SUBSECTION_KEYS.find((key) => key.field === "reviewerNotes")!.heading}`);

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
