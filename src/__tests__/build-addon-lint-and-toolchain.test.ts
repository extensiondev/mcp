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
const { buildCliAnswer, browserFromCliArgs, writeEngineDist } = await import("./fixtures/engine-answers");

const tmpDirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-lint-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1.0.0" }));

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

  it("keeps the validator's line and the review risk, and drops the engine's copy and the Store review echo from warnings", async () => {
    const dir = project();
    summaryOverride = { warnings_count: 1, warnings: [ENGINE_LINE] };

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "firefox" }));
    const said = result.warnings.filter((w: string) => w.includes("data_collection_permissions"));

    expect(result.ok).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("ask the person and write their answer");
    expect(result.value.reviewRisks.map((r: { code: string }) => r.code)).toContain("FIREFOX_DATA_COLLECTION_MISSING");
    expect(result.value.buildWarningsTruncated).toBeUndefined();
  });

  it("carries the engine's line when validation was skipped, since nothing else says it", async () => {
    const dir = project();
    summaryOverride = { warnings_count: 1, warnings: [ENGINE_LINE] };

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "firefox", skipValidation: true }));

    expect(result.warnings).toContain(ENGINE_LINE);
  });
});
