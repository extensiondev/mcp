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

const CONSTANT_CHECKS: Record<string, string> = {
  typeof: "typeof chrome.debugger !== 'undefined'",
  in: "'debugger' in chrome",
  "&&": "chrome.debugger && typeof chrome.debugger.attach === 'function'",
  "optional chain": "Boolean(chrome.debugger?.attach)",
};

const CONSTANT_SHAPES: Record<string, (check: string) => string> = {
  "early return": (check) =>
    `const hasDebugger = ${check};\nfunction attach() {\n  if (!hasDebugger) return;\n  chrome.debugger.attach({ tabId: 1 }, '1.3');\n}\n`,
  "if block": (check) =>
    `const hasDebugger = ${check};\nif (hasDebugger) {\n  chrome.debugger.onDetach.addListener(() => {});\n}\n`,
};

const LEDGER_491 = `const hasDebugger = typeof chrome.debugger !== 'undefined';

function attach(tabId) {
  if (!hasDebugger) return;
  chrome.debugger.attach({ tabId }, '1.3');
}

async function send(tabId, method) {
  if (!hasDebugger) return undefined;
  return chrome.debugger.sendCommand({ tabId }, method);
}

if (hasDebugger) {
  chrome.debugger.onDetach.addListener(() => {});
}
`;

const UNTIED_CHECK = `let ready = false;
if (typeof chrome.debugger !== 'undefined') ready = true;
function attach() {
  if (!ready) return;
  chrome.debugger.attach({ tabId: 1 }, '1.3');
}
`;

const DEBUGGER_ON_CHROMIUM_ONLY = { "chrome:permissions": undefined, "chromium:permissions": ["debugger"] };

const tmpDirs: string[] = [];
let prevFetch: typeof fetch;

function leon(files: Record<string, string>, manifest: Record<string, unknown> = {}): string {
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
      ...manifest,
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

describe("a check held in a constant guards the calls behind it, and an untied check warns (ledger 491)", () => {
  const background = path.join("src", "background.js");

  for (const [shape, build] of Object.entries(CONSTANT_SHAPES)) {
    for (const [check, expression] of Object.entries(CONSTANT_CHECKS)) {
      it(`reads the ${check} check through a const as guarded in the ${shape} shape`, () => {
        const uses = apiUsesIn("a.js", build(expression), "debugger");

        expect(uses.length).toBeGreaterThan(0);
        expect(uses.every((use) => use.guarded && use.namespace === "chrome")).toBe(true);
      });
    }
  }

  it("passes the ledger's background for firefox with the calls named as guarded chrome.debugger", async () => {
    const dir = leon({ "background.js": LEDGER_491 }, DEBUGGER_ON_CHROMIUM_ONLY);

    const out = JSON.parse(await validate.handler({ projectPath: dir, browsers: ["firefox"] }));
    const warnings = out.value.warnings.join(" ");

    expect(out.value.buildBlocking).toBe(false);
    expect(out.value.browserSupport.firefox.issues).toEqual([]);
    expect(warnings).toContain(`chrome.debugger at ${background}:5, ${background}:10, ${background}:14 is guarded: runs only where chrome.debugger exists`);
    expect(warnings).not.toContain("browser.debugger");
  });

  it("still passes the inline typeof guard for firefox, quoting the chrome namespace the source uses", async () => {
    const dir = leon(
      { "background.js": "if (typeof chrome.debugger !== 'undefined') {\n  chrome.debugger.attach({ tabId: 1 }, '1.3');\n}\n" },
      DEBUGGER_ON_CHROMIUM_ONLY,
    );

    const out = JSON.parse(await validate.handler({ projectPath: dir, browsers: ["firefox"] }));

    expect(out.value.buildBlocking).toBe(false);
    expect(out.value.warnings.join(" ")).toContain(`chrome.debugger at ${background}:2 is guarded: runs only where chrome.debugger exists`);
  });

  it("still blocks a call with no check anywhere in its file, quoting the chrome namespace the source uses", async () => {
    const dir = leon({ "background.js": "chrome.debugger.attach({ tabId: 1 }, '1.3');\n" }, DEBUGGER_ON_CHROMIUM_ONLY);

    const out = JSON.parse(await validate.handler({ projectPath: dir, browsers: ["firefox"] }));
    const issues = out.value.browserSupport.firefox.issues.join(" ");

    expect(out.value.buildBlocking).toBe(true);
    expect(issues).toContain(`Code calls chrome.debugger at ${background}:1`);
    expect(issues).toContain("An unguarded call crashes this target at runtime. Guard it (chrome.debugger?.method(...)");
    expect(issues).not.toContain("browser.debugger");
  });

  it("blocks a bare browser.debugger call on a chromium target under the browser namespace", async () => {
    const dir = leon(
      { "background.js": "browser.debugger.attach({ tabId: 1 }, '1.3');\n" },
      { "chrome:permissions": undefined, "firefox:permissions": ["debugger"] },
    );

    const out = JSON.parse(await validate.handler({ projectPath: dir, browsers: ["chrome", "firefox"] }));

    expect(out.value.buildBlocking).toBe(true);
    expect(out.value.browserSupport.firefox.issues).toEqual([]);
    expect(out.value.browserSupport.chrome.issues.join(" ")).toContain(`Code calls browser.debugger at ${background}:1`);
  });

  it("warns instead of blocking when the file checks for the namespace but the check cannot be tied to the call", async () => {
    const dir = leon({ "background.js": UNTIED_CHECK }, DEBUGGER_ON_CHROMIUM_ONLY);

    const out = JSON.parse(await validate.handler({ projectPath: dir, browsers: ["firefox"] }));
    const warnings = out.value.warnings.join(" ");

    expect(out.value.buildBlocking).toBe(false);
    expect(out.value.browserSupport.firefox.issues).toEqual([]);
    expect(warnings).toContain(`chrome.debugger at ${background}:5 may run unguarded`);
    expect(warnings).toContain("that check could not be tied to this call");
  });
});
