import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import type * as ExecModule from "../lib/exec";
import type * as TemplatesCacheModule from "../lib/templates-cache";

let onDist: ((distDir: string, browser: string) => void) | null = null;
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      const browser = browserFromCliArgs(args);
      const answer = buildCliAnswer(args[1]!, browser);
      writeEngineDist(args[1]!, browser);
      onDist?.(path.join(args[1]!, "dist", browser), browser);

      return answer;
    },
  };
});

vi.mock("../lib/templates-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof TemplatesCacheModule>();

  return { ...actual, listTemplates: async () => [] };
});

const build = await import("../tools/build");
const manifestValidate = await import("../tools/manifest-validate");
const { buildCliAnswer, browserFromCliArgs, writeEngineDist } = await import("./fixtures/engine-answers");
const { droppedRuntimePages } = await import("../lib/dropped-runtime-pages");

const tmpDirs: string[] = [];

const PREFIXED_SIDEBAR = {
  "chromium:side_panel": { default_path: "sidebar/index.html", default_title: "Panel" },
  "firefox:sidebar_action": { default_panel: "sidebar/index.html", default_title: "Panel" },
};

const OPENS_THE_PANEL = [
  "const PANEL_PAGE = 'sidebar/index.html'",
  "chrome.action.onClicked.addListener(async () => {",
  "  await chrome.windows.create({url: chrome.runtime.getURL(PANEL_PAGE), width: 420, height: 820})",
  "})",
  "",
].join("\n");

function project(manifestKeys: Record<string, unknown>, background = OPENS_THE_PANEL): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dropped-page-"));
  tmpDirs.push(dir);
  write(dir, "src/manifest.json", JSON.stringify({
    "chromium:manifest_version": 3,
    "firefox:manifest_version": 2,
    name: "Fixture",
    version: "1.0.0",
    icons: { "128": "images/icon-128.png" },
    background: { "chromium:service_worker": "background.ts", "firefox:scripts": ["background.ts"] },
    "chromium:permissions": ["sidePanel"],
    ...manifestKeys,
  }));

  write(dir, "src/background.ts", background);
  write(dir, "src/sidebar/index.html", "<html><body>panel</body></html>");
  write(dir, "src/images/icon-128.png", "");

  return dir;
}

function write(root: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

function engineDropsTheSidebar(distDir: string, browser: string): void {
  if (browser !== "safari") return;

  fs.rmSync(path.join(distDir, "sidebar"), { recursive: true, force: true });
  write(distDir, "manifest.json", JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1.0.0", background: { scripts: ["background.js"] } }));
  write(distDir, "background.js", "");
}

afterEach(() => {
  onDist = null;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("449: a page the Safari build drops while the background opens it at runtime is named with its fix", () => {
  it("extension_build for safari warns with the file, the keys, the source site and the pages/ fix, and lists it in value.droppedRuntimePages", async () => {
    const dir = project(PREFIXED_SIDEBAR);
    onDist = engineDropsTheSidebar;

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "safari" }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("built");
    expect(result.value.droppedRuntimePages).toEqual([
      expect.objectContaining({
        file: "sidebar/index.html",
        declaredUnder: ["chromium:side_panel.default_path", "firefox:sidebar_action.default_panel"],
        openedBy: ["src/background.ts:1"],
      }),
    ]);

    const lines = result.warnings.filter((w: string) => w.includes("sidebar/index.html is declared only under"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("chromium:side_panel.default_path and firefox:sidebar_action.default_panel");
    expect(lines[0]).toContain("the safari build does not keep");
    expect(lines[0]).toContain("dist/safari has no copy of it");
    expect(lines[0]).toContain("src/background.ts:1 names it at runtime");
    expect(lines[0]).toContain("move the page to pages/sidebar.html at the project root");
    expect(lines[0]).toContain("or declare it under a manifest key the safari build keeps");
  });

  it("the same project built for chromium keeps the page and answers no such warning", async () => {
    const dir = project(PREFIXED_SIDEBAR);

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "chromium" }));

    expect(result.ok).toBe(true);
    expect(result.value.droppedRuntimePages).toBeUndefined();
    expect(result.warnings.join("\n")).not.toContain("is declared only under");
  });

  it("a page declared under an unprefixed key the build keeps answers none", async () => {
    const dir = project({ options_ui: { page: "sidebar/index.html" } });

    onDist = (distDir, browser) => {
      if (browser === "safari") write(distDir, "manifest.json", JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1.0.0", options_ui: { page: "sidebar/index.html" } }));
    };

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "safari" }));

    expect(result.ok).toBe(true);
    expect(result.value.droppedRuntimePages).toBeUndefined();
    expect(result.warnings.join("\n")).not.toContain("is declared only under");
  });

  it("a page declared only under prefixed keys but never named in the source answers none", async () => {
    const dir = project(PREFIXED_SIDEBAR, "chrome.action.onClicked.addListener(() => console.log('clicked'))\n");
    onDist = engineDropsTheSidebar;

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "safari" }));

    expect(result.ok).toBe(true);
    expect(result.value.droppedRuntimePages).toBeUndefined();
    expect(result.warnings.join("\n")).not.toContain("is declared only under");
  });

  it("extension_manifest_validate with browsers: [safari] says the build will have no copy, while the default browser list stays quiet", async () => {
    const dir = project(PREFIXED_SIDEBAR);

    const safari = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["safari"] }));
    const line = safari.value.warnings.find((w: string) => w.includes("sidebar/index.html is declared only under"));
    expect(line).toContain("the safari build will have no copy of it");
    expect(line).toContain("src/background.ts:1 names it at runtime");

    const chrome = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["chrome"] }));
    expect(chrome.value.warnings.join("\n")).not.toContain("is declared only under");

    const defaults = JSON.parse(await manifestValidate.handler({ projectPath: dir }));
    expect(defaults.value.warnings.join("\n")).not.toContain("is declared only under");
  });

  it("the build says the fact once: the preflight line gives way to the dist read, and a page already under pages/ is not named", async () => {
    const dir = project({ "chromium:side_panel": { default_path: "pages/panel.html" } }, "const url = chrome.runtime.getURL('pages/panel.html')\nchrome.windows.create({url})\n");
    write(dir, "pages/panel.html", "<html></html>");

    onDist = (distDir, browser) => {
      if (browser !== "safari") return;

      write(distDir, "pages/panel.html", "<html></html>");
      write(distDir, "manifest.json", JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1.0.0" }));
    };

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "safari" }));

    expect(result.ok).toBe(true);
    expect(result.warnings.filter((w: string) => w.includes("is declared only under"))).toHaveLength(0);
    expect(droppedRuntimePages(dir, "safari")).toEqual([]);
  });

  it("a dist that holds no manifest yet, the dev session before its first compile, answers none", () => {
    const dir = project(PREFIXED_SIDEBAR);

    expect(droppedRuntimePages(dir, "safari", path.join(dir, "dist", "safari"))).toEqual([]);
    expect(droppedRuntimePages(dir, "safari").map((page) => page.file)).toEqual(["sidebar/index.html"]);
  });
});
