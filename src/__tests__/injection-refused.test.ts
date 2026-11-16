import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

import { actFailure, attachedDevContract } from "./fixtures/engine-answers";
import { writeEvalToken } from "./fixtures/ready-contract";
import { nameRefusedInjection } from "../lib/injection-refusal";

import type * as ExecModule from "../lib/exec";
import type * as CdpPortModule from "../lib/cdp-port";

const cliCalls: string[][] = [];
let refusalMessage = "Missing host permission for the tab";

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cliCalls.push(args);

      return {
        code: 1,
        stdout: JSON.stringify(
          actFailure(args[0] ?? "eval", {
            name: "InjectionRefused",
            code: "E_COMMAND_UNSUPPORTED_FOR_TARGET",
            message: refusalMessage,
          }),
        ),
        stderr: "",
      };
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return { ...actual, resolveRdpPort: async () => null, resolveCdpPort: async () => null };
});

const evalTool = await import("../tools/eval");
const domSnapshot = await import("../tools/dom-snapshot");
const inspect = await import("../tools/inspect");

const tmpDirs: string[] = [];

function liveProject(browser: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-injection-refused-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "dist", "extension-js", browser, "ready.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(attachedDevContract(browser, { allowEval: true, cdpPort: undefined })));
  writeEvalToken(dir, browser);

  return dir;
}

afterEach(() => {
  cliCalls.length = 0;
  refusalMessage = "Missing host permission for the tab";
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const calls = {
  extension_eval: (projectPath: string, browser: string, url: string) =>
    evalTool.handler({ projectPath, browser, context: "page", url, expression: "document.title" }),
  extension_dom_snapshot: (projectPath: string, browser: string, url: string) =>
    domSnapshot.handler({ projectPath, browser, context: "page", url }),
  extension_inspect: (projectPath: string, browser: string, url: string) =>
    inspect.handler({ projectPath, browser, context: "page", url } as never),
};

describe("a tab the browser refuses to script is named as such, never as a missing target", () => {
  it("897: reads a long hostile document name in linear time", () => {
    const refusal = () => ({ ok: false, status: "", hint: "", error: { name: "InjectionRefused", code: "E_COMMAND_UNSUPPORTED_FOR_TARGET", message: "refused" } });
    const hostile = refusal();
    const started = performance.now();

    nameRefusedInjection(hostile, { browser: "firefox", url: `${".htm#".repeat(40_000)}\nx` });

    expect(performance.now() - started).toBeLessThan(400);
    expect(hostile.error.code).toBe("E_EXTENSION_PAGE_UNREACHABLE");

    for (const [url, code] of [["options.html", "E_EXTENSION_PAGE_UNREACHABLE"], ["pages/popup.htm?a=1#b", "E_EXTENSION_PAGE_UNREACHABLE"], ["https://example.com/a.html", "E_PAGE_NOT_SCRIPTABLE"], ["*.html", "E_PAGE_NOT_SCRIPTABLE"], ["two words.html", "E_PAGE_NOT_SCRIPTABLE"]] as const) {
      const frame = refusal();

      nameRefusedInjection(frame, { browser: "firefox", url });

      expect(frame.error.code, url).toBe(code);
    }
  });

  it.each(Object.keys(calls) as Array<keyof typeof calls>)(
    "%s answers a refused web page as not scriptable",
    async (tool) => {
      const project = liveProject("firefox");

      const answer = JSON.parse(await calls[tool](project, "firefox", "https://example.com/*"));

      expect(cliCalls.length).toBeGreaterThan(0);
      expect(answer.ok).toBe(false);
      expect(answer.error.code).toBe("E_PAGE_NOT_SCRIPTABLE");
      expect(answer.error.message).toContain("Missing host permission");
      expect(answer.hint).toMatch(/host_permissions/);
    },
  );

  it.each([
    ["extension_eval", () => evalTool.handler({ projectPath: tmpDirs[0]!, browser: "chrome", context: "page", tab: 12, expression: "document.title" })],
    ["extension_dom_snapshot", () => domSnapshot.handler({ projectPath: tmpDirs[0]!, browser: "chrome", context: "page", tab: 12 })],
  ] as const)("%s answers a refused extension tab as unreachable and names the surface route", async (_tool, call) => {
    liveProject("chrome");
    refusalMessage = 'Cannot access contents of url "chrome-extension://abc/options.html". Extension manifest must request permission to access this host.';

    const answer = JSON.parse(await call());

    expect(cliCalls.length).toBeGreaterThan(0);
    expect(answer.ok).toBe(false);
    expect(answer.error.code).toBe("E_EXTENSION_PAGE_UNREACHABLE");
    expect(answer.hint).toMatch(/context: "options"/);
  });
});
