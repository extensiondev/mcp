import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import type * as ExecModule from "../lib/exec";

let summaryOverride: Record<string, unknown> = {};
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      const browser = browserFromCliArgs(args);
      const answer = buildCliAnswer(args[1]!, browser);
      writeEngineDist(args[1]!, browser);
      const frame = JSON.parse(answer.stdout) as { value: { summaries: Array<Record<string, unknown>> } };
      frame.value.summaries = frame.value.summaries.map((s) => ({ ...s, ...summaryOverride }));
      answer.stdout = `${JSON.stringify(frame)}\n`;

      return answer;
    },
  };
});

const build = await import("../tools/build");
const analyze = await import("../tools/analyze");
const { buildCliAnswer, browserFromCliArgs, writeEngineDist } = await import("./fixtures/engine-answers");

const tmpDirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-lint-"));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  srcManifest(dir);

  return dir;
}

function srcManifest(dir: string): void {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1.0.0" }));
}

function bareSrcProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-bare-"));
  tmpDirs.push(dir);
  srcManifest(dir);

  return dir;
}

function staleNote(dir: string): string {
  const note = path.join(dir, "dist", "amo-reviewer-note.md");
  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, "# Notes to reviewer\n\nMANIFEST_UPDATE_URL\n");
  const old = new Date(Date.now() - 6 * 60 * 60 * 1000);
  fs.utimesSync(note, old, old);

  return note;
}

afterEach(() => {
  summaryOverride = {};
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const TOOLCHAIN = { node: "v24.18.1", extension_js: "4.1.36", package_manager: { name: "npm", version: "12.0.2" } };

describe("425: a skipped AMO lint is answered, with the install line, and a stale reviewer note is named", () => {
  it("answers value.addonLint missing with the install hint, warns with the config key, and calls the earlier note stale", async () => {
    const dir = project();
    const note = staleNote(dir);
    summaryOverride = { addon_lint: { status: "missing" } };

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "firefox" }));

    expect(result.ok).toBe(true);
    expect(result.value.addonLint).toEqual({ status: "missing", installHint: "npm install -D addons-linter" });
    const skipped = result.warnings.find((w: string) => w.includes("addons-linter is not installed"));
    expect(skipped).toContain("npm install -D addons-linter");
    expect(skipped).toContain("commands.build.addonLint");
    const stale = result.warnings.find((w: string) => w.includes("stale"));
    expect(stale).toContain(note);
    expect(stale).toContain("earlier build");
  });

  it("answers linted with the finding count and the note this build wrote, and no stale warning", async () => {
    const dir = project();
    summaryOverride = { addon_lint: { status: "linted", findings: 3 } };
    const note = path.join(dir, "dist", "amo-reviewer-note.md");
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, "# Notes to reviewer\n");

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "firefox" }));

    expect(result.value.addonLint).toEqual({ status: "linted", findings: 3, reviewerNotePath: note });
    expect(result.warnings.join(" ")).not.toContain("stale");
    expect(result.warnings.join(" ")).not.toContain("addons-linter is not installed");
  });

  it("carries a browser skip as data only, and nothing when the engine wrote no addon_lint", async () => {
    const dir = project();
    summaryOverride = { addon_lint: { status: "skipped", reason: "browser" } };

    const skipped = JSON.parse(await build.handler({ projectPath: dir }));

    expect(skipped.value.addonLint).toEqual({ status: "skipped", reason: "browser" });
    expect(skipped.warnings.join(" ")).not.toContain("addons-linter");

    summaryOverride = { addon_lint: undefined };
    const none = JSON.parse(await build.handler({ projectPath: project() }));

    expect(none.value.addonLint).toBeUndefined();
  });
});

describe("424: the build answers the toolchain the engine recorded instead of asking the person to copy it by hand", () => {
  it("answers value.toolchain from summary.toolchain", async () => {
    const dir = project();
    summaryOverride = { toolchain: TOOLCHAIN };

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.value.toolchain).toEqual({ node: "v24.18.1", extensionJs: "4.1.36", packageManager: { name: "npm", version: "12.0.2" } });
  });

  it("leaves toolchain out when the engine wrote none", async () => {
    const result = JSON.parse(await build.handler({ projectPath: project() }));

    expect(result.value.toolchain).toBeUndefined();
  });
});

describe("a Firefox build says the missing data collection declaration once", () => {
  const ENGINE_LINE =
    '⚠ ⏵⏵⏵ addons.mozilla.org requires browser_specific_settings.gecko.data_collection_permissions for new add-ons.\n  │ Declare {"required": ["none"]} if this extension transmits no data.';

  it.each([
    ["with the manifest check", {}],
    ["with validation skipped", { skipValidation: true }],
  ])("%s, says it in value.reviewRisks alone, with the owner's rule, and warnings carry neither the validator's line nor the engine's", async (_label, extra) => {
    const dir = project();
    summaryOverride = { warnings_count: 1, warnings: [ENGINE_LINE] };

    const text = await build.handler({ projectPath: dir, browser: "firefox", ...extra });
    const result = JSON.parse(text);
    const risk = result.value.reviewRisks.find((r: { code: string }) => r.code === "FIREFOX_DATA_COLLECTION_MISSING");

    expect(result.ok).toBe(true);
    expect(risk.fix).toContain("Ask the owner what the extension collects");
    expect(risk.fix).toContain("Do not fill it in for them or suggest a value");
    expect(result.warnings.filter((w: string) => w.includes("data_collection_permissions"))).toEqual([]);
    expect(text.split("data_collection_permissions")).toHaveLength(3);
    expect(result.value.buildWarningsTruncated).toBeUndefined();
  });

  it("928: repeats the validator's line to write the Firefox add-on ID now, with the proposed value in value.proposedGeckoId, and the declaration rule names the declaration alone", async () => {
    const dir = project();
    summaryOverride = {};

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "firefox" }));
    const lines = result.warnings.filter((w: string) => w.includes("no browser_specific_settings.gecko.id"));
    const risk = result.value.reviewRisks.find((r: { code: string }) => r.code === "FIREFOX_DATA_COLLECTION_MISSING");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Write it now as firefox:browser_specific_settings.gecko.id with the value "fixture@example.com"');
    expect(lines[0]).toContain("It is provisional and locks at the first Firefox submission, so tell the owner you wrote it and that they can change it before then.");
    expect(result.value.proposedGeckoId).toBe("fixture@example.com");
    expect(risk.fix).toContain("Do not fill it in for them or suggest a value. This rule is about the declaration alone.");

    const chrome = JSON.parse(await build.handler({ projectPath: dir, browser: "chrome" }));

    expect(chrome.value.proposedGeckoId).toBeUndefined();
  });
});

describe("916: a build answer says each review risk once and stays light", () => {
  function riskyProject(): string {
    const dir = project();
    fs.writeFileSync(
      path.join(dir, "src", "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Fixture",
        version: "1.0.0",
        icons: { 128: "icon.png" },
        browser_specific_settings: { gecko: { id: "fixture@example.com" } },
        content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
      }),
    );

    fs.writeFileSync(path.join(dir, "src", "content.js"), "console.log('ok')\n");
    fs.writeFileSync(path.join(dir, "src", "icon.png"), "");

    return dir;
  }

  it("carries each risk in value.reviewRisks and names its code in one Store review line, never its message or fix a second time", async () => {
    const dir = riskyProject();
    summaryOverride = { addon_lint: { status: "missing" }, toolchain: TOOLCHAIN };

    const text = await build.handler({ projectPath: dir, browser: "firefox" });
    const result = JSON.parse(text);
    const risks: Array<{ code: string; message: string; fix: string }> = result.value.reviewRisks;
    const pointers = result.warnings.filter((w: string) => w.startsWith("Store review:"));

    expect(risks.map((risk) => risk.code)).toEqual(expect.arrayContaining(["BROAD_HOST_ACCESS", "FIREFOX_DATA_COLLECTION_MISSING"]));
    expect(pointers).toHaveLength(1);
    expect(pointers[0]).toContain("value.reviewRisks");

    for (const risk of risks) {
      expect(pointers[0], risk.code).toContain(risk.code);
      expect(text.split(JSON.stringify(risk.message).slice(1, -1)), risk.code).toHaveLength(2);
      expect(text.split(JSON.stringify(risk.fix).slice(1, -1)), risk.code).toHaveLength(2);
    }
  });

  it("answers a Firefox build with two review risks, a missing lint, a toolchain and the STORE.md line of ledger 919 in under 2,600 characters, with a hint under 300 and no output tail the fields already carry", async () => {
    const dir = riskyProject();
    summaryOverride = { addon_lint: { status: "missing" }, toolchain: TOOLCHAIN };

    const text = (await build.handler({ projectPath: dir, browser: "firefox" }))
      .split(JSON.stringify(dir).slice(1, -1))
      .join("/work")
      .split("\\\\")
      .join("/");
    const result = JSON.parse(text);

    expect(result.ok).toBe(true);
    expect(text.length, `${text.length} characters`).toBeLessThanOrEqual(2_600);
    expect(result.hint.length, result.hint).toBeLessThanOrEqual(300);
    expect(result.hint).toMatch(/^The production build is in \/work\/dist\/firefox\. /);
    expect(result.hint).toContain('call extension_analyze with this projectPath and browser "firefox"');
    expect(result.value).not.toHaveProperty("output");
    expect(result.value.outputPath).toBe("/work/dist/firefox");
  });

  it("919: says once, in warnings, to write STORE.md with a justification for each declared permission, host permission and content script match, and names no data-use value", async () => {
    const dir = riskyProject();

    const missing = JSON.parse(await build.handler({ projectPath: dir, browser: "firefox" }));
    const lines = missing.warnings.filter((w: string) => w.includes("STORE.md"));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`No STORE.md is in ${dir}. Write it there now from the manifest and the code`);
    expect(lines[0]).toContain("## Chrome Web Store with a ### Permissions justification bullet per declared permission, host permission and content script match");
    expect(lines[0]).toContain("## Firefox Add-ons with ### Reviewer notes, ## Edge Add-ons");
    expect(lines[0]).toContain('extension_docs_search "STORE.md" has the rest');
    expect(lines[0]).toContain("Leave only its data-use and privacy rows unanswered");
    expect(lines[0]).not.toMatch(/none|collects nothing|no data/i);
    expect(missing.hint).not.toContain("STORE.md");

    fs.writeFileSync(path.join(dir, "STORE.md"), "# Store metadata\n");

    const present = JSON.parse(await build.handler({ projectPath: dir, browser: "firefox" }));
    const checks = present.warnings.filter((w: string) => w.includes("STORE.md"));

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatch(/^STORE\.md: check that a "### Permissions justification" bullet /);

    const clean = riskyProject();
    fs.writeFileSync(path.join(clean, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1.0.0", icons: { 128: "icon.png" } }));
    fs.writeFileSync(path.join(clean, "STORE.md"), "# Store metadata\n");

    const quiet = JSON.parse(await build.handler({ projectPath: clean }));

    expect(quiet.value.reviewRisks).toBeUndefined();
    expect(quiet.warnings.join(" ")).not.toContain("STORE.md");
  });

  it("919: a missing 128 pixel icon is a review risk with its fix, said by the risk alone", async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, "STORE.md"), "# Store metadata\n");

    const text = await build.handler({ projectPath: dir });
    const result = JSON.parse(text);
    const risk = result.value.reviewRisks.find((r: { code: string }) => r.code === "ICON_128_MISSING");

    expect(risk.fix).toContain('add "icons": { "128": "icons/icon-128.png" } to the manifest');
    expect(result.warnings.find((w: string) => w.startsWith("Store review:"))).toContain("ICON_128_MISSING");
    expect(result.warnings.filter((w: string) => w.includes("No 128x128 icon declared"))).toEqual([]);
    expect(text.split("128x128")).toHaveLength(3);
  });

  it("the missing icon fix names the 128 pixel PNG the project already holds, and a placeholder to save and report when it holds none", async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, "STORE.md"), "# Store metadata\n");
    const fixOf = async () => JSON.parse(await build.handler({ projectPath: dir })).value.reviewRisks.find((r: { code: string }) => r.code === "ICON_128_MISSING").fix;

    expect(await fixOf()).toContain('save a plain placeholder PNG there as icons/icon-128.png, add "icons": { "128": "icons/icon-128.png" } to the manifest, build again and tell the owner it is a placeholder');

    fs.mkdirSync(path.join(dir, "src", "images"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "images", "logo.png"), Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.from([0, 0, 0, 128, 0, 0, 0, 128, 8, 6, 0, 0, 0])]));

    expect(await fixOf()).toBe('images/logo.png under the manifest\'s folder is 128x128: add "icons": { "128": "images/logo.png" } to the manifest and build again.');
  });
});

describe("925: one project root an answer, the folder the engine built from", () => {
  it("answers a src manifest with no package.json from the manifest's folder: dist, the zip, the STORE.md line and value.projectRoot agree, in one line", async () => {
    const dir = bareSrcProject();
    const root = path.join(dir, "src");

    const text = await build.handler({ projectPath: dir, browser: "chrome" });
    const result = JSON.parse(text);
    const rootLines = result.warnings.filter((w: string) => w.startsWith("Project root:"));

    expect(result.ok).toBe(true);
    expect(result.value.projectRoot).toBe(root);
    expect(result.value.outputPath).toBe(path.join(root, "dist", "chrome"));
    expect(fs.existsSync(path.join(root, "dist", "chrome", "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "dist"))).toBe(false);
    expect(result.warnings.find((w: string) => w.includes("STORE.md is in"))).toContain(`No STORE.md is in ${dir}. Write it there now`);
    expect(rootLines[0]).toContain("STORE.md stays in the folder above");
    expect(rootLines).toHaveLength(1);
    expect(rootLines[0]).toContain(root);
    expect(rootLines[0]).toContain("conventional layout");
    expect(rootLines[0]).not.toMatch(/\b(add|create|move)\b/i);
    expect(result.hint).toContain(`The production build is in ${path.join(root, "dist", "chrome")}.`);
    expect(text.split(JSON.stringify(dir).slice(1, -1)).join("/work").length).toBeLessThanOrEqual(2_300);
  });

  it("lets extension_analyze read that build from the projectPath the build was given, with the same root line and STORE.md folder", async () => {
    const dir = bareSrcProject();
    const root = path.join(dir, "src");
    await build.handler({ projectPath: dir, browser: "chrome" });

    const analyzed = JSON.parse(await analyze.handler({ projectPath: dir, browser: "chrome" }));

    expect(analyzed.ok).toBe(true);
    expect(analyzed.value.projectRoot).toBe(root);
    expect(analyzed.warnings.filter((w: string) => w.startsWith("Project root:"))).toHaveLength(1);
    expect(analyzed.warnings.find((w: string) => w.includes("STORE.md is in"))).toContain(`No STORE.md is in ${dir}. Write it there now`);
  });

  it("reads a STORE.md already beside src and asks for no second one", async () => {
    const dir = bareSrcProject();
    fs.writeFileSync(path.join(dir, "STORE.md"), "## Chrome Web Store\n");

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "chrome" }));

    expect(result.warnings.filter((w: string) => w.includes("No STORE.md"))).toEqual([]);
  });

  it("finds a STORE.md someone put in src, says where it was read from and asks nobody to move it", async () => {
    const dir = bareSrcProject();
    const file = path.join(dir, "src", "STORE.md");
    fs.writeFileSync(file, "## Chrome Web Store\n");

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "chrome" }));
    const found = result.warnings.filter((w: string) => w.startsWith("STORE.md was read from"));

    expect(result.warnings.filter((w: string) => w.includes("No STORE.md"))).toEqual([]);
    expect(found).toEqual([`STORE.md was read from ${file}, in the manifest's folder.`]);

    const analyzed = JSON.parse(await analyze.handler({ projectPath: dir, browser: "chrome" }));

    expect(analyzed.warnings.filter((w: string) => w.startsWith("STORE.md was read from"))).toEqual(found);
  });

  it("names no root and adds no line when a package.json sits beside src, the conventional layout", async () => {
    const dir = project();

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "chrome" }));

    expect(result.value).not.toHaveProperty("projectRoot");
    expect(result.value.outputPath).toBe(path.join(dir, "dist", "chrome"));
    expect(result.warnings.filter((w: string) => w.startsWith("Project root:"))).toEqual([]);
    expect(result.warnings.find((w: string) => w.includes("STORE.md is in"))).toContain(`No STORE.md is in ${dir}.`);
  });
});
