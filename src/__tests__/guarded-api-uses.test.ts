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

const ALIAS_DECLARATIONS: Record<string, string> = {
  "a direct assignment": "const api = chrome;",
  "globalThis.browser ?? chrome": "const api = globalThis.browser ?? chrome;",
  "a typeof conditional": "const api = typeof browser !== \"undefined\" ? browser : chrome;",
  "a typed const": "const api: typeof chrome = (globalThis.browser || chrome);",
};

const NOT_THE_NAMESPACE: Record<string, string> = {
  "a function parameter of the alias's name": "const api = chrome;\nfunction build(api) {\n  api.contextMenus.create({ id: 'a' });\n}\n",
  "an arrow parameter of the alias's name": "const api = chrome;\nconst build = (api) => api.contextMenus.create({ id: 'a' });\n",
  "a catch binding of the alias's name": "const api = chrome;\ntry {\n  run();\n} catch (api) {\n  api.contextMenus.create({ id: 'a' });\n}\n",
  "a second declaration in an inner block": "const api = chrome;\n{\n  const api = makeClient();\n  api.contextMenus.create({ id: 'a' });\n}\n",
  "a let that is assigned again": "let api = chrome;\napi = makeClient();\napi.contextMenus.create({ id: 'a' });\n",
  "an object built by a call": "const api = makeClient();\napi.contextMenus.create({ id: 'a' });\n",
  "a namespace member, not the namespace": "const api = chrome.runtime;\napi.contextMenus.create({ id: 'a' });\n",
  "a member read continued on the next line": "const api = chrome\n  .runtime;\napi.contextMenus.create({ id: 'a' });\n",
  "a property of another object": "const api = chrome;\nclient.api.contextMenus.create({ id: 'a' });\n",
  "destructuring from another object": "const { contextMenus } = settings;\ncontextMenus.create({ id: 'a' });\n",
  "a destructured name bound again as a parameter": "const { contextMenus } = chrome;\nfunction list(contextMenus) {\n  return contextMenus.create({ id: 'a' });\n}\n",
};

const MENUS_PER_BROWSER = {
  "chrome:permissions": undefined,
  "chromium:permissions": ["storage", "contextMenus"],
  "firefox:permissions": ["storage", "menus"],
  "firefox:background": { scripts: ["background.js"] },
};

describe("an alias of the extension namespace is read as the namespace (ledger 944)", () => {
  const background = path.join("src", "background.js");

  for (const [name, declaration] of Object.entries(ALIAS_DECLARATIONS)) {
    it(`reads a call through ${name} as a use, named as the source writes it`, () => {
      const uses = apiUsesIn("background.js", `${declaration}\n\napi.contextMenus.create({ id: 'a' });\n`, "contextMenus");

      expect(uses).toEqual([{ file: "background.js", line: 3, namespace: "api", guarded: false, checked: false }]);
    });
  }

  it("reads a destructured namespace, renamed or taken from an alias, as a use", () => {
    expect(apiUsesIn("a.js", "const { contextMenus } = chrome;\n\ncontextMenus.create({ id: 'a' });\n", "contextMenus")).toEqual([
      { file: "a.js", line: 3, namespace: "chrome", guarded: false, checked: false },
    ]);

    expect(
      apiUsesIn("a.js", "const api = globalThis.browser ?? chrome;\nconst { storage, contextMenus: menu } = api;\nmenu.onClicked.addListener(() => {});\n", "contextMenus"),
    ).toEqual([{ file: "a.js", line: 3, namespace: "chrome", guarded: false, checked: false }]);

    expect(apiUsesIn("a.js", "const { contextMenus } = browser;\ncontextMenus.create({ id: 'a' });\n", "contextMenus")[0].namespace).toBe("browser");
  });

  it("keeps the guards it knows when the namespace is read through an alias", () => {
    const ifGuard = apiUsesIn("a.js", "const api = chrome;\nif (api.contextMenus) {\n  api.contextMenus.create({ id: 'a' });\n}\n", "contextMenus");
    const chain = apiUsesIn("a.js", "const api = chrome;\napi.contextMenus?.create({ id: 'a' });\n", "contextMenus");
    const inCheck = apiUsesIn("a.js", "const api = chrome;\nif ('contextMenus' in api) {\n  api.contextMenus.create({ id: 'a' });\n}\n", "contextMenus");

    expect(ifGuard).toEqual([{ file: "a.js", line: 3, namespace: "api", guarded: true, checked: true }]);
    expect(chain).toEqual([{ file: "a.js", line: 2, namespace: "api", guarded: true, checked: true }]);
    expect(inCheck).toEqual([{ file: "a.js", line: 3, namespace: "api", guarded: true, checked: true }]);
  });

  for (const [name, source] of Object.entries(NOT_THE_NAMESPACE)) {
    it(`reads no use through ${name}`, () => {
      expect(apiUsesIn("a.js", source, "contextMenus")).toEqual([]);
    });
  }

  it("leaves a source with no alias as it read before", () => {
    expect(apiUsesIn("a.js", "const api = chrome;\nchrome.contextMenus.create({ id: 'a' });\n", "contextMenus")).toEqual([
      { file: "a.js", line: 2, namespace: "chrome", guarded: false, checked: false },
    ]);
  });

  it("blocks the firefox target when the aliased call needs contextMenus and firefox is granted menus alone", async () => {
    const dir = leon(
      { "background.js": "const api = globalThis.browser ?? chrome;\n\napi.runtime.onInstalled.addListener(() => {\n  api.contextMenus.create({ id: 'save', title: 'Save', contexts: ['selection'] });\n});\n" },
      MENUS_PER_BROWSER,
    );

    const out = JSON.parse(await validate.handler({ projectPath: dir, browsers: ["chrome", "firefox"] }));
    const issues = out.value.browserSupport.firefox.issues.join(" ");

    expect(out.status).toBe("invalid");
    expect(out.value.buildBlocking).toBe(true);
    expect(out.value.browserSupport.chrome.issues).toEqual([]);
    expect(issues).toContain(`Code calls api.contextMenus at ${background}:4 but the firefox build's permissions do not include "contextMenus"`);
    expect(issues).toContain("add \"contextMenus\" to \"firefox:permissions\"");
    expect(issues).toContain("Guard it (api.contextMenus?.method(...), if (api.contextMenus), typeof api.contextMenus !== \"undefined\", or 'contextMenus' in api)");
    expect(issues).toContain("In Firefox \"menus\" grants browser.menus alone, and browser.contextMenus needs \"contextMenus\".");
  });

  it("passes the same source once firefox is granted contextMenus, and warns when no target is", async () => {
    const source = "const api = globalThis.browser ?? chrome;\n\napi.contextMenus.create({ id: 'save', title: 'Save' });\n";
    const granted = leon({ "background.js": source }, { ...MENUS_PER_BROWSER, "firefox:permissions": ["storage", "contextMenus"] });
    const nowhere = leon({ "background.js": source }, { ...MENUS_PER_BROWSER, "chromium:permissions": ["storage"] });

    const passed = JSON.parse(await validate.handler({ projectPath: granted, browsers: ["chrome", "firefox"] }));
    const warned = JSON.parse(await validate.handler({ projectPath: nowhere, browsers: ["chrome", "firefox"] }));

    expect(passed.value.browserSupport.firefox.issues).toEqual([]);
    expect(passed.value.warnings.join(" ")).not.toContain("contextMenus");
    expect(warned.value.warnings.join(" ")).toContain("Code calls chrome.contextMenus but \"contextMenus\" is not in permissions");
  });
});
