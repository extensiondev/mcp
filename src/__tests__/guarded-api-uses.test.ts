import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ExecModule from "../lib/exec";

const cliCalls: string[][] = [];
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cliCalls.push(args);
      const browser = browserFromCliArgs(args);
      const answer = buildCliAnswer(args[1]!, browser);
      if (answer.code === 0) writeEngineDist(args[1]!, browser);

      return answer;
    },
  };
});

const build = await import("../tools/build");
const validate = await import("../tools/manifest-validate");
const { apiUsesIn } = await import("../lib/guarded-api-uses");
const { buildCliAnswer, browserFromCliArgs, writeEngineDist } = await import("./fixtures/engine-answers");

const SAVE_FILE = `export async function saveFile(url, filename) {
  if (chrome.downloads?.download) return chrome.downloads.download({ url, filename });

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
}
`;

const GUARDED_CASES: Record<string, string> = {
  "optional chain": "chrome.downloads?.download({ url: 'a' });\n",
  "if guard": "if (chrome.downloads) {\n  chrome.downloads.download({ url: 'a' });\n}\n",
  typeof: "if (typeof chrome.downloads !== \"undefined\") {\n  chrome.downloads.download({ url: 'a' });\n}\n",
  in: "if ('downloads' in chrome) {\n  chrome.downloads.download({ url: 'a' });\n}\n",
};

const tmpDirs: string[] = [];
let prevFetch: typeof fetch;

function leon(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-guarded-uses-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Leon",
      version: "1.0.0",
      "chrome:permissions": ["downloads"],
      background: { service_worker: "background.js" },
    }),
  );

  fs.writeFileSync(path.join(dir, "src", "background.js"), "import './shared/utils/save-file.js';\n");

  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, "src", rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }

  return dir;
}

beforeEach(() => {
  prevFetch = global.fetch;
  global.fetch = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = prevFetch;
  cliCalls.length = 0;

  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("guarded API uses follow the engine's webkitGuardedRanges rule", () => {
  for (const [name, source] of Object.entries(GUARDED_CASES)) {
    it(`reads the ${name} case as guarded`, () => {
      const uses = apiUsesIn("a.js", source, "downloads");

      expect(uses.length).toBeGreaterThan(0);
      expect(uses.every((use) => use.guarded)).toBe(true);
    });

    it(`validates the ${name} case for safari as a guarded warning naming the file and line`, async () => {
      const dir = leon({ "shared/utils/save-file.js": source });

      const out = JSON.parse(await validate.handler({ projectPath: dir, browsers: ["safari"] }));
      const line = source.includes("{\n") ? 2 : 1;

      expect(out.value.buildBlocking).toBe(false);
      expect(out.value.browserSupport.safari.issues).toEqual([]);
      expect(out.value.warnings.join(" ")).toContain(
        `chrome.downloads at ${path.join("src", "shared", "utils", "save-file.js")}:${line} is guarded: runs only where chrome.downloads exists`,
      );
    });
  }

  it("blocks a bare chrome.downloads.download call with its file and line, and never suggests skipValidation", async () => {
    const dir = leon({ "shared/utils/save-file.js": "const x = 1;\n\nchrome.downloads.download({ url: 'a' });\n" });

    const out = JSON.parse(await validate.handler({ projectPath: dir, browsers: ["safari"] }));
    const issues = out.value.browserSupport.safari.issues.join(" ");

    expect(out.value.buildBlocking).toBe(true);
    expect(issues).toContain(`chrome.downloads at ${path.join("src", "shared", "utils", "save-file.js")}:3`);
    expect(issues).toContain("An unguarded call crashes this target at runtime");
    expect(issues).not.toContain("skipValidation");
  });

  it("builds leon's save-file.js shape for safari without skipValidation", async () => {
    const dir = leon({ "shared/utils/save-file.js": SAVE_FILE });

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "safari" }));

    expect(result.status).not.toBe("manifest-blocked");
    expect(cliCalls).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("is guarded: runs only where chrome.downloads exists");
  });
});
