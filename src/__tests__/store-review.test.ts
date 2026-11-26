import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { STORE_SECTIONS, SUBSECTION_KEYS } from "../lib/store-md-declarations";
import { buildSummaryPath } from "../lib/session-paths";
import { reviewDistReport, reviewRisksReport, storeMdLine, wasmGrantLine } from "../lib/store-review";
import { reviewerNoteBuildLine, reviewerNoteToolchainCheck } from "../lib/store-md-toolchain";

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
    expect(reviewDistReport(dist, "chrome").manifestUnreadable).toBe("ENOENT");

    write("manifest.json", "SECRET_TOKEN=hunter2-first-line\n");

    expect(reviewDistReport(dist, "chrome").manifestUnreadable).toBe("not valid JSON at line 1, column 1");
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
      `No STORE.md is in ${dist}. Write it there now from the manifest and the code, one section per store: ## Chrome Web Store with a ### Permissions justification bullet per declared permission, host permission and content script match, ## Firefox Add-ons with ### Reviewer notes, ## Edge Add-ons (extension_docs_search "STORE.md" has the rest). Under ### Reviewer notes write "Build from source with Node <version>, <package manager> <version> and Extension.js <version>: run <install command>, then <build command>." with the versions extension_build answers in value.toolchain and say that the source is attached or where it is: the engine bundles the package's scripts, and Firefox reviewers rebuild bundled, minified or generated code from source. Leave only its data-use and privacy rows unanswered for the owner, and show them what the code stores and sends.`,
    );

    expect(line).not.toMatch(/before a store submission|ask the owner for/i);

    for (const store of ["chrome", "firefox", "edge"] as const) expect(line).toContain(STORE_SECTIONS[store]);

    expect(line).toContain(`${STORE_SECTIONS.firefox} with ${SUBSECTION_KEYS.find((key) => key.field === "reviewerNotes")!.heading}`);

    expect(line).not.toMatch(/none|collects nothing|no data/i);
  });

  it("947: says what the Firefox reviewer notes hold for a bundled package, with the build line written out from the toolchain the build recorded", () => {
    const summary = buildSummaryPath(dist, "firefox");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(summary, JSON.stringify({ toolchain: { node: "v24.22.3", extension_js: "4.1.41", package_manager: { name: "pnpm", version: "10.19.0" } } }));
    write("package.json", JSON.stringify({ scripts: { "build:firefox": "extension build --browser firefox" } }));

    const line = storeMdLine(dist, [])!;

    expect(line).toContain(
      `## Firefox Add-ons with ### Reviewer notes, ## Edge Add-ons (extension_docs_search "STORE.md" has the rest). Under ### Reviewer notes write "Build from source with Node 24.22.3, pnpm 10.19.0 and Extension.js 4.1.41: run pnpm install, then pnpm run build:firefox." and say that the source is attached or where it is: the engine bundles the package's scripts, and Firefox reviewers rebuild bundled, minified or generated code from source. Leave only its data-use and privacy rows unanswered for the owner`,
    );

    expect(line).not.toContain("<version>");
    expect(reviewerNoteBuildLine(/"(Build from source[^"]+)"/.exec(line)![1])).toMatchObject({ node: "24.22.3", packageManager: { name: "pnpm", version: "10.19.0" }, extensionJs: "4.1.41", sample: false });
  });

  it("says to check the bullets of a STORE.md that is there when the build has review risks, and nothing when it has none", () => {
    write("STORE.md", "# Store metadata\n");

    expect(storeMdLine(dist, [])).toBeNull();
    expect(storeMdLine(dist, [risk])).toBe(
      'STORE.md: check that a "### Permissions justification" bullet under "## Chrome Web Store" covers each permission, host permission and content script match the manifest declares.',
    );
  });
});

describe("971: a Safari build names App Store review and the section Safari reads", () => {
  it("words the broad host access risk for App Store review, keeping Chrome and AMO for the others", () => {
    manifest({ host_permissions: ["<all_urls>"] });

    const safari = reviewDistReport(dist, "safari").risks.find((r) => r.code === "BROAD_HOST_ACCESS")!;
    const chrome = reviewDistReport(dist, "chrome").risks.find((r) => r.code === "BROAD_HOST_ACCESS")!;

    expect(safari.message).toContain("App Store reviewers ask why");
    expect(safari.message).not.toMatch(/Chrome Web Store|Firefox Add-ons/);
    expect(chrome.message).toContain("Chrome Web Store and Firefox Add-ons reviewers ask why");
  });

  it("points a STORE.md check at the Safari section's reviewer notes", () => {
    write("STORE.md", "# Store metadata\n");

    expect(storeMdLine(dist, [{ code: "BROAD_HOST_ACCESS", message: "m", fix: "f" }], "safari")).toBe(
      'STORE.md: check that "### Reviewer notes" under "## Safari" says why the extension needs each permission, host permission and content script match the manifest declares.',
    );
  });

  it("asks a Safari build with no STORE.md for the Safari section its own follow-up check reads, and no other build for it", () => {
    const first = storeMdLine(dist, [], "safari")!;

    write("STORE.md", "# Store metadata\n");
    const followUp = storeMdLine(dist, [{ code: "BROAD_HOST_ACCESS", message: "m", fix: "f" }], "safari")!;
    const [, heading, section] = followUp.match(/"(### [^"]+)" under "(## [^"]+)"/)!;

    expect(first.indexOf(section!)).toBeGreaterThan(-1);
    expect(first.slice(first.indexOf(section!))).toContain(heading!.replace(/^### /, ""));

    fs.rmSync(path.join(dist, "STORE.md"));

    expect(storeMdLine(dist, [], "chrome")).not.toContain(section!);
    expect(storeMdLine(dist, [], "firefox")).toBe(storeMdLine(dist, []));
  });
});

describe("949: Firefox reviewer notes with no build line are named, with the line to write", () => {
  const NOTES_WITHOUT_A_LINE = "# Store metadata\n\n## Firefox Add-ons\n\n### Reviewer notes\n\nThe content script runs on all URLs to read the selection.\n";
  const chain = { node: "24.22.3", packageManager: { name: "pnpm", version: "10.19.0" }, extensionJs: "4.1.41" };
  const toolchain = { localBuild: { chain, from: "the local firefox build (extension_build)" }, packageManager: "pnpm", firefoxBuildScript: "build:firefox" };
  const sentence = "Build from source with Node 24.22.3, pnpm 10.19.0 and Extension.js 4.1.41: run pnpm install, then pnpm run build:firefox.";

  it("answers the check as an advisory warning that carries the line to write, filled from the last build", () => {
    const check = reviewerNoteToolchainCheck({ projectPath: dist, storeMd: NOTES_WITHOUT_A_LINE, toolchain })!;

    expect(check).toMatchObject({
      id: "firefox.reviewer_note_toolchain",
      status: "warn",
      severity: "advisory",
      stage: "review",
      expected: sentence,
      actual: "no build line",
      message: `The Firefox reviewer note in STORE.md has no build line, and Mozilla's reviewers rebuild a bundled add-on from that line. Write under \`### Reviewer notes\` in \`## Firefox Add-ons\` of STORE.md: ${sentence}`,
      write: { file: "STORE.md", section: "## Firefox Add-ons", heading: "### Reviewer notes", with: sentence },
    });

    expect(check.write).not.toHaveProperty("replace");
  });

  it("says to build once when no build is on record, and names the same line for a Firefox section with no reviewer notes at all", () => {
    const unbuilt = reviewerNoteToolchainCheck({ projectPath: dist, storeMd: NOTES_WITHOUT_A_LINE, toolchain: { ...toolchain, localBuild: null } })!;
    const bare = reviewerNoteToolchainCheck({ projectPath: dist, storeMd: "## Firefox Add-ons\n\n- Category: Productivity\n", toolchain })!;

    expect(unbuilt.message).toBe(
      'The Firefox reviewer note in STORE.md has no build line, and Mozilla\'s reviewers rebuild a bundled add-on from that line. No build toolchain was read to fill it: run extension_build with browser "firefox" once, and this check names the line to write.',
    );

    expect(unbuilt.write).toEqual({ file: "STORE.md", section: "## Firefox Add-ons", heading: "### Reviewer notes" });
    expect(bare.write).toMatchObject({ with: sentence });
  });

  it("stays silent with no STORE.md, with no Firefox section, and when the notes carry the line the build ran", () => {
    expect(reviewerNoteToolchainCheck({ projectPath: dist, storeMd: null, toolchain })).toBeNull();
    expect(reviewerNoteToolchainCheck({ projectPath: dist, storeMd: "# Store metadata\n\n## Chrome Web Store\n\n### Permissions justification\n\n- storage: saves the list.\n", toolchain })).toBeNull();
    expect(reviewerNoteToolchainCheck({ projectPath: dist, storeMd: `## Firefox Add-ons\n\n### Reviewer notes\n\n${sentence}\n`, toolchain })).toBeNull();
    expect(reviewerNoteToolchainCheck({ projectPath: "", storeMd: NOTES_WITHOUT_A_LINE, toolchain })).toBeNull();
  });

  it("says the same in the build's STORE.md line for a file that is there, and nothing without a Firefox section", () => {
    write("STORE.md", NOTES_WITHOUT_A_LINE);

    expect(storeMdLine(dist, [])).toBe(
      'STORE.md: "### Reviewer notes" under "## Firefox Add-ons" has no build line. Under ### Reviewer notes write "Build from source with Node <version>, <package manager> <version> and Extension.js <version>: run <install command>, then <build command>." with the versions extension_build answers in value.toolchain and say that the source is attached or where it is: the engine bundles the package\'s scripts, and Firefox reviewers rebuild bundled, minified or generated code from source.',
    );

    write("STORE.md", `## Firefox Add-ons\n\n### Reviewer notes\n\n${sentence}\n`);

    expect(storeMdLine(dist, [])).toBeNull();
  });
});

describe("934: the review reads WebAssembly, where it is loaded from and what the policy grants", () => {
  const POLICY = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";
  const remote = () => reviewDistReport(dist, "chrome").risks.find((r) => r.code === "REMOTE_CODE");

  it("flags a .wasm fetched from another origin, with the file and the address, and says to ship it in the package", () => {
    manifest({ content_security_policy: { extension_pages: POLICY } });
    write("newtab.js", 'const WASM_URL = "https://cdn.jsdelivr.net/npm/@bokuweb/zstd-wasm@0.0.27/dist/web/zstd.wasm"; init(WASM_URL);');

    const risk = remote()!;

    expect(risk.message).toContain("a WebAssembly binary loaded from https://cdn.jsdelivr.net/npm/@bokuweb/zstd-wasm@0.0.27/dist/web/zstd.wasm");
    expect(risk.message).toContain("Stores treat a .wasm fetched from another origin as remotely hosted code");
    expect(risk.fix).toMatch(/^Ship the \.wasm in the package and load it by a packaged URL \(new URL\("<file>\.wasm", import\.meta\.url\) or chrome\.runtime\.getURL\)/);
    expect(risk.files).toEqual(["newtab.js"]);
  });

  it("flags a remote base handed to a loader option, minified or not, and names the option", () => {
    manifest({ content_security_policy: { extension_pages: POLICY } });
    write("background/service_worker.js", "const t=await e({locateFile:e=>`https://cdn.jsdelivr.net/npm/sql.js@1.14.2/dist/$" + "{e}`});");
    write("worker.js", 'createFFmpeg({\n  corePath: "https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js",\n});');

    const risk = remote()!;

    expect(risk.message).toContain("a WebAssembly binary loaded from https://cdn.jsdelivr.net/npm/sql.js@1.14.2/dist/ (locateFile)");
    expect(risk.message).toContain("https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js (corePath)");
    expect(risk.files).toEqual(expect.arrayContaining(["background/service_worker.js", "worker.js"]));
  });

  it("leaves a packaged .wasm URL, an API endpoint, a localhost address and an address beside an unrelated loader option alone", () => {
    manifest({ content_security_policy: { extension_pages: POLICY } });
    write("add.wasm", "");
    write(
      "background.js",
      [
        'const a = new URL("sql.js/dist/sql-wasm-browser.wasm", import.meta.url).href;',
        'const b = chrome.runtime.getURL("add.wasm");',
        'const c = new URL(/* asset */ "./add.wasm", import.meta.url);',
        'fetch("https://api.example.com/v1/items?kind=wasm");',
        'fetch("http://localhost:8080/dev/add.wasm");',
        'boot({ locateFile: (file) => file, api: "https://api.example.com/v2" });',
        'const docs = "See https://emscripten.org/docs/api_reference/module.html for locateFile";',
      ].join("\n"),
    );

    expect(codes()).toEqual([]);
  });

  it("flags a built .wasm beside a Manifest V3 manifest without the grant, and not once the grant is there", () => {
    manifest({ background: { service_worker: "background.js" } });
    write("assets/zstd.wasm", "");
    write("background.js", "self.x = 1;");

    const risk = reviewDistReport(dist, "chrome").risks.find((r) => r.code === "WASM_GRANT_MISSING")!;

    expect(risk.message).toBe("The build ships assets/zstd.wasm and the manifest has no 'wasm-unsafe-eval' in content_security_policy.extension_pages, so extension pages and the background service worker or script cannot compile it.");
    expect(risk.fix).toBe(`Add "content_security_policy": { "extension_pages": "${POLICY}" } to the source manifest and build again. A content script compiles under the host page's policy, which this grant does not change.`);
    expect(risk.files).toEqual(["assets/zstd.wasm"]);

    manifest({ content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'" } });
    expect(codes()).toEqual([]);

    manifest({ manifest_version: 2, content_security_policy: "script-src 'self'" });
    expect(codes("firefox")).not.toContain("WASM_GRANT_MISSING");
  });

  it("flags 'unsafe-eval' in a Manifest V3 policy and names the narrow grant, and never reads 'wasm-unsafe-eval' as it", () => {
    manifest({ content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'; object-src 'self'" } });
    write("assets/zstd.wasm", "");

    const report = reviewDistReport(dist, "chrome");
    const risk = report.risks.find((r) => r.code === "CSP_UNSAFE_EVAL")!;

    expect(report.risks.map((r) => r.code)).toEqual(["CSP_UNSAFE_EVAL"]);
    expect(risk.message).toBe("content_security_policy.extension_pages carries 'unsafe-eval'. Manifest V3 permits only 'self', 'none' and 'wasm-unsafe-eval' in script-src, and reviewers read it as leave to run code the package did not ship.");
    expect(risk.fix).toBe("For WebAssembly write 'wasm-unsafe-eval' in its place, the narrow grant that compiles a module and nothing else; otherwise remove it.");
    expect(wasmGrantLine(report)).toBeNull();

    manifest({ content_security_policy: { extension_pages: POLICY } });
    expect(codes()).toEqual([]);
  });

  it("says once that the grant is the narrow one and where STORE.md justifies it, only for a manifest that carries it", () => {
    manifest({ content_security_policy: { extension_pages: POLICY } });

    expect(wasmGrantLine(reviewDistReport(dist, "chrome"))).toBe(
      `STORE.md: the manifest grants 'wasm-unsafe-eval', the narrow grant for WebAssembly, and reviewers ask what compiles under it. Say which module does and that its binary ships in the package, in "### Reviewer notes" under "## Firefox Add-ons" and "### Certification notes" under "## Edge Add-ons".`,
    );

    manifest({});
    expect(wasmGrantLine(reviewDistReport(dist, "chrome"))).toBeNull();
  });
});
