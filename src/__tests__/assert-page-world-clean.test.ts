import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  GUEST_ID,
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
} from "./assert-page-world-harness";

const { pageWorldReadScript, resourceProbeScript } = await import("../tools/assert-page-world-reads");

usePageWorldProject();

describe("page-world-clean", () => {
  it("passes a clean page and states what it looked at", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();

    const { frame, check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(frame.ok).toBe(true);
    expect(check.subject).toBe(PAGE_URL);
    expect(check.detail).toMatch(/120,000 bytes of outerHTML/);
    expect(check.detail).toMatch(/900 elements/);
    expect(check.detail).toMatch(/4 own window propert/);
    expect(check.detail).toMatch(/1 static web_accessible_resources path/);
    expect(check.detail).toMatch(/web_accessible_resources\[0\] declares use_dynamic_url/);
    expect(check.evidence.resources.probed[0]).toMatchObject({ index: 1, path: "images/logo.png", ok: false });
    expect(live.probeExpressions[0]).toContain(`chrome-extension://${GUEST_ID}/images/logo.png`);
  });

  it("fails on a DOM attribute carrying the extension base url and names the element", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    const read = cleanRead();
    read.dom.occurrences = 1;
    read.dom.hits = [{ tag: "html", attribute: "data-lens-base", value: `chrome-extension://${GUEST_ID}/` }];
    live.pageRead = read;

    const { frame, check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("fail");
    expect(frame.ok).toBe(false);
    expect(check.detail).toMatch(/1 DOM reference/);
    expect(check.detail).toContain('html[data-lens-base]="chrome-extension://');
    expect(check.evidence.dom.hits).toHaveLength(1);
    expect(check.evidence.dom.hits[0].devRuntime).toBeUndefined();
  });

  it("fails on a symbol marker whose description names the extension", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    const read = cleanRead();
    read.symbols = [`lens-hook@${GUEST_ID}`];
    live.pageRead = read;

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toMatch(/1 symbol marker on window naming the extension/);
    expect(check.detail).toContain(`Symbol(lens-hook@${GUEST_ID})`);
    expect(check.evidence.globals.attributedSymbols).toEqual([`lens-hook@${GUEST_ID}`]);
  });

  it("fails on a window global whose value names the extension", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    const read = cleanRead();
    read.ownNames.push("__EXTJS_EXTENSION_BASE__");
    read.refs = [{ name: "__EXTJS_EXTENSION_BASE__", where: "value", value: `chrome-extension://${GUEST_ID}/` }];
    live.pageRead = read;

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toMatch(/1 window global naming the extension \(__EXTJS_EXTENSION_BASE__ = "chrome-extension:/);
    expect(check.detail).not.toMatch(/Warning: .*__EXTJS_EXTENSION_BASE__/);
  });

  it("fails when a static web_accessible_resources path answers from the page", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    live.probeAnswers = [{ index: 1, ok: true, status: 200 }];

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toContain(`web_accessible_resources[1] answers 200 at chrome-extension://${GUEST_ID}/images/logo.png`);
    expect(check.detail).toMatch(/fingerprintable by url guessing/);
    expect(check.detail).toMatch(/web_accessible_resources\[0\] declares use_dynamic_url/);
  });

  it("resolves a glob against the built dist and says which globs it could not", async () => {
    writeManifest({
      ...STATIC_MANIFEST,
      web_accessible_resources: [
        { resources: ["images/*.png"], matches: ["<all_urls>"] },
        { resources: ["fonts/*.woff2"], matches: ["<all_urls>"] },
      ],
    });

    writeDistFile("images/logo.png");
    liveSession();
    openPage();
    live.probeAnswers = [{ index: 0, ok: false, error: "Failed to fetch" }];

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(check.evidence.resources.probed).toEqual([
      expect.objectContaining({ index: 0, path: "images/logo.png", pattern: "images/*.png" }),
    ]);

    expect(check.detail).toMatch(/web_accessible_resources\[1\] .*fonts\/\*\.woff2.*could not be resolved/);
  });

  it("says a refused resource is unproven when the entry's matches do not cover the page", async () => {
    writeManifest({
      ...STATIC_MANIFEST,
      web_accessible_resources: [{ resources: ["images/logo.png"], matches: ["https://shop.example/*"] }],
    });

    liveSession();
    openPage();
    live.probeAnswers = [{ index: 0, ok: false, error: "Failed to fetch" }];

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(check.detail).toMatch(/web_accessible_resources\[0\] .*not covered by its matches \(https:\/\/shop\.example\/\*\)/);
  });

  it("reports globals absent from the blank frame as a warning, never a fail, and honors pageGlobals", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    const read = cleanRead();
    read.ownNames.push("ytInitialData", "ytcfg");
    live.pageRead = read;

    const warned = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(warned.check.outcome).toBe("pass");
    expect(warned.check.detail).toMatch(/Warning: 2 own window propert.* \(ytInitialData, ytcfg\)/);
    expect(warned.check.evidence.globals.unknown).toEqual(["ytInitialData", "ytcfg"]);

    live.pageRead = read;
    const listed = await assertOnce({ assert: "page-world-clean", url: PAGE_URL, pageGlobals: ["ytInitialData", "ytcfg"] });
    expect(listed.check.outcome).toBe("pass");
    expect(listed.check.detail).not.toMatch(/Warning/);
    expect(listed.check.evidence.globals.unknown).toEqual([]);
  });

  it("is not ready when no open page matches a url pattern, says to open it, and opens nothing itself", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    live.targets = [
      { id: "sw", type: "service_worker", url: `chrome-extension://${GUEST_ID}/sw.js` },
      { id: "other", type: "page", url: "https://shop.example/cart" },
    ];

    const pattern = "https://www.youtube.com/watch?v=*";

    const { frame, check } = await assertOnce({ assert: "page-world-clean", url: pattern });
    expect(check.outcome).toBe("inconclusive");
    expect(check.reason).toBe("not-ready");
    expect(frame.ok).toBe(false);
    expect(check.detail).toContain(pattern);
    expect(check.detail).toContain("https://shop.example/cart");
    expect(check.settledBy).toContain("extension_open");
    expect(live.created).toEqual([]);
  });

  it("is inconclusive when the main world does not answer the read", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    live.readThrows = "the page threw while evaluating: Debugger paused";

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toContain("Debugger paused");
  });

  it("is inconclusive on Firefox and says what would settle it", async () => {
    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL }, "firefox");
    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toContain("firefox");
    expect(check.settledBy).toContain("extension_eval");
    expect(check.settledBy).toContain("moz-extension://");
  });

  it("requires a url", async () => {
    const { frame } = await assertOnce({ assert: "page-world-clean" });
    expect(frame.ok).toBe(false);
    expect(frame.error.message).toContain("expect[0].url is required");
  });

  it("ships main-world scripts the browser can compile", () => {
    expect(() => new vm.Script(pageWorldReadScript(GUEST_ID))).not.toThrow();
    expect(() => new vm.Script(resourceProbeScript([{ index: 1, url: `chrome-extension://${GUEST_ID}/a.png` }]))).not.toThrow();
    expect(pageWorldReadScript(GUEST_ID)).toContain("getOwnPropertySymbols");
    expect(resourceProbeScript([])).toContain("fetch(");
  });
});
