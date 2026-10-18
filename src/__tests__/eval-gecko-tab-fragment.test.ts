// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import { envelope } from "../lib/envelope";
import { matchExtensionPageTargets } from "../lib/cdp-extension-page";
import { pageMatchesUrl } from "../lib/webdriver";
import { actVerbAnswer, evalRefusal } from "./fixtures/engine-answers";

import type { RdpTab } from "../lib/rdp";
import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";
import type * as RdpModule from "../lib/rdp";

const calls: string[][] = [];
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      calls.push(cli);

      return actVerbAnswer(
        evalRefusal({
          code: "E_TARGET_NOT_FOUND",
          name: "TargetNotFound",
          message: "Missing host permission for the tab",
          engine: "firefox",
        }),
        "extension_eval",
      );
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return {
    ...actual,
    resolveCdpPort: async () => null,
    resolveRdpPort: async () => ({ port: 9224, source: "contract" as const }),
  };
});

let openTabs: RdpTab[] = [];
const picked: Array<RdpTab | null | undefined> = [];

vi.mock("../lib/rdp", async (importOriginal) => {
  const actual = await importOriginal<typeof RdpModule>();

  return {
    ...actual,
    rdpListTabs: async () => openTabs,
    rdpEvaluateInTab: async (
      _port: number,
      options: { select: (tabs: RdpTab[]) => RdpTab | null | undefined; expression: string },
    ) => {
      const tab = options.select(openTabs);
      picked.push(tab);
      if (!tab) return { ok: false, name: "TargetNotFound", message: "no open tab matches" };

      return { ok: true, value: tab.title, tab: { url: String(tab.url), title: String(tab.title ?? "") } };
    },
  };
});

const evalTool = await import("../tools/eval");

const BASE = "moz-extension://4a93ac70-455d-4566-af3c-7a794be7f33e/";
const LETTER = `${BASE}pages/pdf.html#http://127.0.0.1:8765/media/letter.pdf`;
const SCAN = `${BASE}pages/pdf.html#http://127.0.0.1:8765/media/scan.pdf`;
const SCAN_TAB: RdpTab = { actor: "scan", url: SCAN, title: "Scan", selected: true };
const LETTER_TAB: RdpTab = { actor: "letter", url: LETTER, title: "Letter" };

const dirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-gecko-fragment-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", "firefox");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "Pdf", background: { scripts: ["background.js"] } }),
  );

  return dir;
}

afterEach(() => {
  calls.length = 0;
  picked.length = 0;
  openTabs = [];
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_eval context page on Firefox keeps the url fragment when picking the tab", () => {
  it("picks the one tab whose fragment matches", async () => {
    const dir = project();
    openTabs = [SCAN_TAB, LETTER_TAB];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "pdf.html#http://127.0.0.1:8765/media/letter.pdf",
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("Letter");
    expect(picked[picked.length - 1]?.actor).toBe("letter");
    expect(String(result.warnings)).toContain(LETTER);
  });

  it("refuses with both candidates when the url matches more than one tab", async () => {
    const dir = project();
    openTabs = [SCAN_TAB, LETTER_TAB];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "pdf.html",
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_AMBIGUOUS_TARGET");
    expect(result.error.message).toContain(LETTER);
    expect(result.error.message).toContain(SCAN);
    expect(picked).toHaveLength(0);
  });

  it("still picks a tab by its document path when neither side carries a fragment", async () => {
    const dir = project();
    openTabs = [
      { actor: "sidebar", url: `${BASE}sidebar/index.html`, title: "Sidebar", selected: true },
      { actor: "pdf", url: `${BASE}pages/pdf.html`, title: "Pdf" },
    ];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "pages/pdf.html",
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("Pdf");
    expect(picked[picked.length - 1]?.actor).toBe("pdf");
  });
});

describe("the other page matchers keep a fragment the caller supplies", () => {
  it("pageMatchesUrl does not match a page that differs only in the fragment", () => {
    expect(pageMatchesUrl(SCAN, "pdf.html#http://127.0.0.1:8765/media/letter.pdf")).toBe(false);
    expect(pageMatchesUrl(LETTER, "pdf.html#http://127.0.0.1:8765/media/letter.pdf")).toBe(true);
    expect(pageMatchesUrl(SCAN, "pdf.html")).toBe(true);
    expect(pageMatchesUrl(SCAN, LETTER)).toBe(false);
    expect(pageMatchesUrl(LETTER, LETTER)).toBe(true);
  });

  it("matchExtensionPageTargets keeps only the target whose fragment matches", () => {
    const chromeLetter = "chrome-extension://abc/pages/pdf.html#letter";
    const targets = [
      { targetId: "scan", type: "page", url: "chrome-extension://abc/pages/pdf.html#scan", title: "" },
      { targetId: "letter", type: "page", url: chromeLetter, title: "" },
    ];

    expect(matchExtensionPageTargets(targets, chromeLetter).map((t) => t.targetId)).toEqual(["letter"]);
    expect(matchExtensionPageTargets(targets, "chrome-extension://abc/pages/pdf.html").map((t) => t.targetId)).toEqual([
      "scan",
      "letter",
    ]);
  });
});
