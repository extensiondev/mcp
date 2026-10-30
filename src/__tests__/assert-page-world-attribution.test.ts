import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  BASELINE,
  GUEST_ID,
  PAGE_URL,
  STATIC_MANIFEST,
  assertOnce,
  cleanRead,
  live,
  liveSession,
  openPage,
  usePageWorldProject,
  writeManifest,
  writeSourceManifest,
  type PageRead,
} from "./assert-page-world-harness";

const { FRAME_BASELINE_SCRIPT } = await import("../tools/assert-page-world-reads");

usePageWorldProject();

describe("page-world-clean attribution (ledger 272 and 273)", () => {
  it("warns on a symbol the site defines itself, never fails, and keeps it in the evidence", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    const read = cleanRead();
    read.symbols = ["google.goem", "soccer-lens-media-hook"];
    live.pageRead = read;

    const { frame, check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(frame.ok).toBe(true);
    expect(check.detail).toMatch(/Warning: 2 unattributed symbols on window \(Symbol\(google\.goem\), Symbol\(soccer-lens-media-hook\)\)/);
    expect(check.evidence.globals.symbols).toEqual(["google.goem", "soccer-lens-media-hook"]);
    expect(check.evidence.globals.attributedSymbols).toEqual([]);

    live.pageRead = read;
    const listed = await assertOnce({ assert: "page-world-clean", url: PAGE_URL, pageGlobals: ["google.goem", "soccer-lens-media-hook"] });
    expect(listed.check.outcome).toBe("pass");
    expect(listed.check.detail).not.toMatch(/Warning/);
  });

  it("reads the baseline from a blank same-origin frame inside the page, so secure-context globals are not unknown", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    const read = cleanRead();
    read.ownNames.push("cookieStore", "GPU", "sharedStorage");
    live.pageRead = read;
    live.frameBaselineNames = [...BASELINE, "cookieStore", "GPU", "sharedStorage"];

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(check.detail).not.toMatch(/Warning/);
    expect(check.evidence.globals.unknown).toEqual([]);
    expect(check.evidence.globals.baseline).toBe("same-origin-frame");
    expect(check.evidence.globals.baselineNote).toBeUndefined();
    expect(live.created).toEqual([]);
    expect(live.attached).toEqual(["tab"]);
  });

  it("falls back to a background about:blank tab when a content script may inject into blank frames, and says so", async () => {
    writeManifest({
      ...STATIC_MANIFEST,
      content_scripts: [{ matches: ["https://*.youtube.com/*"], js: ["content.js"], all_frames: true, match_about_blank: true }],
    });

    liveSession();
    openPage();
    const read = cleanRead();
    read.ownNames.push("cookieStore");
    live.pageRead = read;
    live.frameBaselineNames = [...BASELINE, "cookieStore"];

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(live.created).toEqual([{ url: "about:blank", background: true }]);
    expect(live.closed).toEqual(["blank-1"]);
    expect(check.evidence.globals.baseline).toBe("created-blank");
    expect(check.evidence.globals.baselineNote).toContain("content_scripts[0] declares match_about_blank");
    expect(check.evidence.globals.unknown).toEqual(["cookieStore"]);
    expect(check.detail).toContain("not on a blank tab");
    expect(check.detail).toContain("content_scripts[0] declares match_about_blank");

    live.created = [];
    live.closed = [];
    live.pageRead = cleanRead();
    live.targets = [...live.targets, { id: "spare", type: "page", url: "about:blank" }];
    const reused = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(reused.check.outcome).toBe("pass");
    expect(reused.check.evidence.globals.baseline).toBe("existing-blank");
    expect(live.created).toEqual([]);
    expect(live.closed).toEqual([]);
    expect(live.attached).toContain("spare");
  });

  it("falls back to a background about:blank tab when the page does not answer the frame read", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession();
    openPage();
    live.frameBaselineNames = null;

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(live.created).toEqual([{ url: "about:blank", background: true }]);
    expect(check.evidence.globals.baseline).toBe("created-blank");
    expect(check.evidence.globals.baselineNote).toContain("did not answer the same-origin frame read");
  });

  it("ships a frame baseline script the browser can compile", () => {
    expect(() => new vm.Script(FRAME_BASELINE_SCRIPT)).not.toThrow();
    expect(FRAME_BASELINE_SCRIPT).toContain('createElement("iframe")');
    expect(FRAME_BASELINE_SCRIPT).toContain("frame.remove()");
  });

  const DEV_MANIFEST = {
    ...STATIC_MANIFEST,
    web_accessible_resources: [
      { resources: ["bridge.js"], matches: ["<all_urls>"], use_dynamic_url: true },
      { resources: ["images/logo.png"], matches: ["<all_urls>"] },
      { resources: ["assets/ort.webgpu.bundle.min.bed0cfc8.mjs"], matches: ["<all_urls>"] },
      { resources: ["extension-js-control.json"], matches: ["<all_urls>"] },
    ],
  };
  const SOURCE_MANIFEST = {
    manifest_version: 3,
    content_scripts: [{ matches: ["https://*.youtube.com/*"], js: ["content.js"] }],
    web_accessible_resources: [
      { resources: ["bridge.js"], matches: ["<all_urls>"], use_dynamic_url: true },
      { resources: ["images/*.png"], matches: ["<all_urls>"] },
    ],
  };

  function devRuntimeRead(): PageRead {
    const read = cleanRead();
    read.dom.occurrences = 2;
    read.dom.hits = [
      { tag: "html", attribute: "data-extjs-extension-base", value: `chrome-extension://${GUEST_ID}/` },
      { tag: "div", attribute: "data-extjs-marker-owner", value: `content_scripts/content-0::script-0@${GUEST_ID}` },
    ];

    return read;
  }

  it("labels the dev runtime's markers and resources devRuntime on a dev session and leaves them out of the verdict", async () => {
    writeManifest(DEV_MANIFEST);
    writeSourceManifest(SOURCE_MANIFEST);
    liveSession("dev");
    openPage();
    live.pageRead = devRuntimeRead();
    live.probeAnswers = [
      { index: 1, ok: false, error: "Failed to fetch" },
      { index: 2, ok: true, status: 200 },
      { index: 3, ok: true, status: 200 },
    ];

    const { frame, check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("pass");
    expect(frame.ok).toBe(true);
    expect(check.detail).toContain("4 dev-runtime hits were excluded from the verdict");
    expect(check.detail).toContain("the session's ready contract names the dev command");
    expect(check.detail).toContain("run the check on an extension_start session for the shipped answer");
    expect(check.detail).toMatch(/1 static web_accessible_resources path fetched from the page was refused \(images\/logo\.png\)/);
    expect(check.evidence.session).toEqual({ kind: "dev", decidedBy: "contract" });
    expect(check.evidence.dom.hits.map((hit: { devRuntime?: true }) => hit.devRuntime)).toEqual([true, true]);
    expect(check.evidence.resources.probed.map((probe: { devRuntime?: true }) => probe.devRuntime)).toEqual([undefined, true, true]);
  });

  it("still fails a dev session on a shipped resource, and excludes the control file by name with no source manifest to diff", async () => {
    writeManifest(DEV_MANIFEST);
    liveSession("dev");
    openPage();
    live.probeAnswers = [
      { index: 1, ok: true, status: 200 },
      { index: 2, ok: false, error: "Failed to fetch" },
      { index: 3, ok: true, status: 200 },
    ];

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toContain(`web_accessible_resources[1] answers 200 at chrome-extension://${GUEST_ID}/images/logo.png`);
    expect(check.detail).not.toContain("extension-js-control.json fetched from the page");
    expect(check.detail).toContain("1 dev-runtime hit was excluded from the verdict");
    expect(check.evidence.resources.probed.map((probe: { devRuntime?: true }) => probe.devRuntime)).toEqual([undefined, undefined, true]);
  });

  it("excludes nothing on an extension_start session, so a dev marker that shipped fails", async () => {
    writeManifest(DEV_MANIFEST);
    writeSourceManifest(SOURCE_MANIFEST);
    liveSession("start");
    openPage();
    live.pageRead = devRuntimeRead();
    live.probeAnswers = [
      { index: 1, ok: false, error: "Failed to fetch" },
      { index: 2, ok: false, error: "Failed to fetch" },
      { index: 3, ok: true, status: 200 },
    ];

    const { check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(check.outcome).toBe("fail");
    expect(check.detail).toMatch(/2 DOM references/);
    expect(check.detail).toContain('html[data-extjs-extension-base]="chrome-extension://');
    expect(check.detail).toContain(`web_accessible_resources[3] answers 200 at chrome-extension://${GUEST_ID}/extension-js-control.json`);
    expect(check.detail).not.toContain("dev-runtime");
    expect(check.evidence.session).toEqual({ kind: "production", decidedBy: "contract" });
    expect(check.evidence.dom.hits[0].devRuntime).toBeUndefined();
    expect(check.evidence.resources.probed.find((probe: { index: number }) => probe.index === 3).devRuntime).toBeUndefined();
  });

  it("decides dev from the control file in the running manifest, or from the markers, when the contract names no command", async () => {
    writeManifest(DEV_MANIFEST);
    writeSourceManifest(SOURCE_MANIFEST);
    liveSession();
    openPage();
    live.probeAnswers = [{ index: 3, ok: true, status: 200 }];

    const byControlFile = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(byControlFile.check.outcome).toBe("pass");
    expect(byControlFile.check.evidence.session).toEqual({ kind: "dev", decidedBy: "control-file" });
    expect(byControlFile.check.detail).toContain("the running manifest lists extension-js-control.json");

    writeManifest(STATIC_MANIFEST);
    live.pageRead = devRuntimeRead();
    live.probeAnswers = [{ index: 1, ok: false, error: "Failed to fetch" }];
    const byMarkers = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(byMarkers.check.outcome).toBe("pass");
    expect(byMarkers.check.evidence.session).toEqual({ kind: "dev", decidedBy: "markers" });
    expect(byMarkers.check.detail).toContain("the page carries data-extjs-* attributes");

    live.pageRead = cleanRead();
    const noSignal = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });
    expect(noSignal.check.outcome).toBe("pass");
    expect(noSignal.check.evidence.session).toEqual({ kind: "production", decidedBy: "no-dev-signal" });
    expect(noSignal.check.detail).not.toContain("dev-runtime");
  });
});
