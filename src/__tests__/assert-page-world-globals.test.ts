import { describe, expect, it } from "vitest";

import {
  PAGE_URL,
  STATIC_MANIFEST,
  assertOnce,
  cleanRead,
  live,
  liveSession,
  openPage,
  usePageWorldProject,
  writeDistFile,
  writeManifest,
  writeSourceManifest,
} from "./assert-page-world-harness";

const { BUNDLE_BYTE_CAP, isEngineGlobal, mainWorldScripts, namesGlobal } = await import("../tools/assert-page-world-globals");

usePageWorldProject();

const MAIN_BUNDLE = "content_scripts/content-0.js";
const ISOLATED_BUNDLE = "content_scripts/content-1.js";
const MAIN_WORLD_MANIFEST = {
  ...STATIC_MANIFEST,
  content_scripts: [
    { matches: ["https://*.youtube.com/*"], js: [MAIN_BUNDLE], world: "MAIN" },
    { matches: ["https://*.youtube.com/*"], js: [ISOLATED_BUNDLE] },
  ],
};

function readWith(...names: string[]) {
  const read = cleanRead();
  read.ownNames.push(...names);
  live.pageRead = read;
}

describe("page-world-clean globals the extension's own build sets (ledger 275)", () => {
  it("fails a production session on a name the Extension.js runtime plants and keeps it out of the unknown warning", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession("start");
    openPage();
    readWith("__EXTENSIONJS_registerCleanup", "ytcfg");

    const { frame, check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("fail");
    expect(frame.ok).toBe(false);
    expect(check.detail).toContain(
      "1 window global the extension's own build sets (__EXTENSIONJS_registerCleanup, which the Extension.js runtime plants)",
    );

    expect(check.detail).toMatch(/Warning: 1 own window property .*not in pageGlobals \(ytcfg\);/);
    expect(check.detail).toContain("declares no content_scripts entry with world: MAIN");
    expect(check.evidence.globals.engineGlobals).toEqual([{ name: "__EXTENSIONJS_registerCleanup" }]);
    expect(check.evidence.globals.builtGlobals).toEqual([]);
    expect(check.evidence.globals.unknown).toEqual(["ytcfg"]);
    expect(check.evidence.globals.bundles.note).toContain("no content_scripts entry with world: MAIN");
  });

  it("labels the runtime's names devRuntime on a dev session and excludes them like the markers", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession("dev");
    openPage();
    readWith("__extjsDevContentScripts", "__EXTENSIONJS_DEV_REINJECT__", "__EXTENSIONJS_registerCleanup", "ytcfg");

    const { frame, check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(frame.ok).toBe(true);
    expect(check.detail).toContain("3 dev-runtime hits were excluded from the verdict");
    expect(check.detail).toContain("window globals it plants");
    expect(check.detail).toMatch(/Warning: 1 own window property .*not in pageGlobals \(ytcfg\);/);
    expect(check.evidence.globals.engineGlobals).toEqual([
      { name: "__extjsDevContentScripts", devRuntime: true },
      { name: "__EXTENSIONJS_DEV_REINJECT__", devRuntime: true },
      { name: "__EXTENSIONJS_registerCleanup", devRuntime: true },
    ]);

    expect(check.evidence.globals.unknown).toEqual(["ytcfg"]);
  });

  it("fails a production session on an unknown global a built MAIN-world bundle writes, naming the file, and never reads an isolated-world bundle", async () => {
    writeManifest(MAIN_WORLD_MANIFEST);
    writeDistFile(MAIN_BUNDLE, 'var ytcfgExtra=1;globalThis.probePlanted=function(e){return e};');
    writeDistFile(ISOLATED_BUNDLE, "window.ytcfg=1;");
    liveSession("start");
    openPage();
    readWith("probePlanted", "ytcfg");

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toContain(`1 window global the extension's own build sets (probePlanted in ${MAIN_BUNDLE})`);
    expect(check.detail).toMatch(/Warning: 1 own window property .*\(ytcfg\)/);
    expect(check.evidence.globals.builtGlobals).toEqual([{ name: "probePlanted", file: MAIN_BUNDLE }]);
    expect(check.evidence.globals.engineGlobals).toEqual([]);
    expect(check.evidence.globals.unknown).toEqual(["ytcfg"]);
    expect(check.evidence.globals.bundles).toEqual({ searched: [MAIN_BUNDLE], skipped: [] });
  });

  it("still fails a dev session on a built global that is not a runtime name, and labels a runtime name found in the bundle devRuntime", async () => {
    writeManifest(MAIN_WORLD_MANIFEST);
    writeDistFile(MAIN_BUNDLE, "globalThis.__EXTENSIONJS_registerCleanup=function(){};window.probePlanted = 1;");
    liveSession("dev");
    openPage();
    readWith("__EXTENSIONJS_registerCleanup", "probePlanted");

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toContain(`1 window global the extension's own build sets (probePlanted in ${MAIN_BUNDLE})`);
    expect(check.detail).toContain("1 dev-runtime hit was excluded from the verdict");
    expect(check.evidence.globals.engineGlobals).toEqual([
      { name: "__EXTENSIONJS_registerCleanup", file: MAIN_BUNDLE, devRuntime: true },
    ]);

    expect(check.evidence.globals.builtGlobals).toEqual([
      { name: "__EXTENSIONJS_registerCleanup", file: MAIN_BUNDLE, devRuntime: true },
      { name: "probePlanted", file: MAIN_BUNDLE },
    ]);

    expect(check.evidence.globals.unknown).toEqual([]);
  });

  it("lets pageGlobals win over both rules", async () => {
    writeManifest(MAIN_WORLD_MANIFEST);
    writeDistFile(MAIN_BUNDLE, "window.probePlanted=1;");
    liveSession("start");
    openPage();
    readWith("__EXTENSIONJS_registerCleanup", "probePlanted");

    const { check } = await assertOnce({
      assert: "page-world-clean",
      url: PAGE_URL,
      pageGlobals: ["__EXTENSIONJS_registerCleanup", "probePlanted"],
    });
    expect(check.outcome).toBe("pass");
    expect(check.detail).not.toMatch(/Warning/);
    expect(check.evidence.globals.engineGlobals).toEqual([]);
    expect(check.evidence.globals.builtGlobals).toEqual([]);
    expect(check.evidence.globals.unknown).toEqual([]);
  });

  it("passes and names the bundle searched when it plants none of the unknown globals", async () => {
    writeManifest(MAIN_WORLD_MANIFEST);
    writeDistFile(MAIN_BUNDLE, "var a=1;");
    liveSession("start");
    openPage();
    readWith("ytcfg");

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(check.detail).toContain(`the 1 built MAIN-world bundle searched (${MAIN_BUNDLE}) plants none of them`);
    expect(check.detail).toMatch(/Warning: 1 own window property .*\(ytcfg\)/);
    expect(check.evidence.globals.bundles).toEqual({ searched: [MAIN_BUNDLE], skipped: [] });
  });

  it("skips a bundle over the byte cap, says so, and keeps the unknown warning", async () => {
    writeManifest(MAIN_WORLD_MANIFEST);
    writeDistFile(MAIN_BUNDLE, `window.probePlanted=1;${"x".repeat(BUNDLE_BYTE_CAP)}`);
    liveSession("start");
    openPage();
    readWith("probePlanted");

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(check.detail).toContain(`${MAIN_BUNDLE} is 5,242,902 bytes, over the 5,242,880 byte cap, so it was not searched`);
    expect(check.detail).toMatch(/Warning: 1 own window property .*\(probePlanted\)/);
    expect(check.evidence.globals.builtGlobals).toEqual([]);
    expect(check.evidence.globals.bundles.searched).toEqual([]);
    expect(check.evidence.globals.bundles.skipped).toEqual([
      { file: MAIN_BUNDLE, reason: expect.stringContaining("over the 5,242,880 byte cap") },
    ]);
  });

  it("says the bundles were not searched when the running manifest is the source one", async () => {
    writeSourceManifest(MAIN_WORLD_MANIFEST);
    liveSession("start");
    openPage();
    readWith("ytcfg");

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(check.detail).toContain("were not searched for the unknown globals because the running manifest is the source one, not a build");
    expect(check.evidence.globals.bundles.note).toContain("the running manifest is the source one");
    expect(check.evidence.globals.bundles.searched).toEqual([]);
  });

  it("reads an identifier as a whole word in the forms a bundle writes a global with", () => {
    expect(namesGlobal('globalThis.__EXTENSIONJS_registerCleanup=function(e){return"function"', "__EXTENSIONJS_registerCleanup")).toBe(true);
    expect(namesGlobal("window.probePlanted = 1", "probePlanted")).toBe(true);
    expect(namesGlobal("self.probePlanted(1)", "probePlanted")).toBe(true);
    expect(namesGlobal("var probePlanted = 1", "probePlanted")).toBe(true);
    expect(namesGlobal('Object.defineProperty(window, "probePlanted", {})', "probePlanted")).toBe(true);
    expect(namesGlobal("window['probePlanted']", "probePlanted")).toBe(true);
    expect(namesGlobal("window.probePlantedExtra = 1", "probePlanted")).toBe(false);
    expect(namesGlobal("probePlantedExtra = 1", "probePlanted")).toBe(false);
    expect(namesGlobal("other.probePlanted = 1", "probePlanted")).toBe(false);
    expect(namesGlobal("if (probePlanted == 1) {}", "probePlanted")).toBe(false);
    expect(namesGlobal("if (probePlanted === 1) {}", "probePlanted")).toBe(false);
    expect(namesGlobal("window.$ = jQuery", "$")).toBe(true);
    expect(namesGlobal('var $ = 1; "$"', "$")).toBe(false);
    expect(namesGlobal("window.yt.config", "yt")).toBe(true);
    expect(namesGlobal("var yt = 1", "yt")).toBe(false);
  });

  it("knows the runtime's prefixes case-insensitively and reads MAIN-world scripts off the manifest", () => {
    expect(isEngineGlobal("__EXTENSIONJS_registerCleanup")).toBe(true);
    expect(isEngineGlobal("__EXTJS_EXTENSION_BASE__")).toBe(true);
    expect(isEngineGlobal("__extjsDevContentScripts")).toBe(true);
    expect(isEngineGlobal("__ExtensionJs_x")).toBe(true);
    expect(isEngineGlobal("__ext")).toBe(false);
    expect(isEngineGlobal("ytcfg")).toBe(false);
    expect(isEngineGlobal("extensionjs")).toBe(false);

    expect(mainWorldScripts(MAIN_WORLD_MANIFEST)).toEqual([MAIN_BUNDLE]);
    expect(mainWorldScripts(STATIC_MANIFEST)).toEqual([]);
    expect(
      mainWorldScripts({
        content_scripts: [
          { js: ["/a.js", "b.js"], world: "MAIN" },
          { js: ["a.js"], world: "MAIN" },
          { js: ["c.js"], world: "ISOLATED" },
          "not an entry",
        ],
      }),
    ).toEqual(["a.js", "b.js"]);
  });
});

const REWRITTEN_ONE =
  "The dev build rewrites the 1 world: MAIN content script of the source manifest (content/media-hook.ts) into isolated loaders, so no built bundle was searched; their globals are judged on an extension_start session";

describe("page-world-clean on a dev session whose source manifest declares MAIN-world scripts (ledger 280)", () => {
  it("says the dev build rewrote the source's MAIN-world script instead of claiming the manifest declares none", async () => {
    writeManifest(STATIC_MANIFEST);
    writeSourceManifest({
      ...STATIC_MANIFEST,
      content_scripts: [
        { matches: ["https://*.youtube.com/*"], js: ["content/media-hook.ts"], world: "MAIN" },
        { matches: ["https://*.youtube.com/*"], js: ["content.ts"] },
      ],
    });

    liveSession("dev");
    openPage();
    readWith("ytcfg");

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(check.detail).toContain(`${REWRITTEN_ONE}.`);
    expect(check.detail).not.toContain("declares no content_scripts entry with world: MAIN");
    expect(check.evidence.globals.bundles.note).toBe(REWRITTEN_ONE);
    expect(check.evidence.globals.bundles.searched).toEqual([]);
    expect(check.evidence.globals.unknown).toEqual(["ytcfg"]);
  });

  it("counts and names every rewritten script", async () => {
    writeManifest(STATIC_MANIFEST);
    writeSourceManifest({
      ...STATIC_MANIFEST,
      content_scripts: [
        { matches: ["<all_urls>"], js: ["content/a.ts", "content/b.ts"], world: "MAIN" },
        { matches: ["<all_urls>"], js: ["content/c.ts"], world: "MAIN" },
      ],
    });

    liveSession("dev");
    openPage();
    readWith("ytcfg");

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.evidence.globals.bundles.note).toBe(
      "The dev build rewrites the 3 world: MAIN content scripts of the source manifest (content/a.ts, content/b.ts, content/c.ts) into isolated loaders, so no built bundle was searched; their globals are judged on an extension_start session",
    );
  });

  it("keeps the no-entry sentence on a dev session whose source manifest declares no MAIN-world script", async () => {
    writeManifest(STATIC_MANIFEST);
    writeSourceManifest(STATIC_MANIFEST);
    liveSession("dev");
    openPage();
    readWith("ytcfg");

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.evidence.globals.bundles.note).toContain("The running manifest declares no content_scripts entry with world: MAIN");
    expect(check.detail).not.toContain("dev build rewrites");
  });

  it("keeps the production read on the running manifest even when the source declares a MAIN-world script", async () => {
    writeManifest(STATIC_MANIFEST);
    writeSourceManifest({
      ...STATIC_MANIFEST,
      content_scripts: [{ matches: ["<all_urls>"], js: ["content/media-hook.ts"], world: "MAIN" }],
    });

    liveSession("start");
    openPage();
    readWith("ytcfg");

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.evidence.globals.bundles.note).toContain("The running manifest declares no content_scripts entry with world: MAIN");
    expect(check.detail).not.toContain("dev build rewrites");
  });
});
