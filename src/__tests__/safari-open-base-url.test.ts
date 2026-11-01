import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { envelope } from "../lib/envelope";
import { logsPath, readyContractPath } from "../lib/session-paths";
import { actFrame, actVerbAnswer, evalRefusal, safariDevContract, tabRows } from "./fixtures/engine-answers";

import type * as ActModule from "../lib/act";

const calls: string[][] = [];
let landed = "";

const cspRefusal = (tool: string) =>
  actVerbAnswer(
    evalRefusal({
      code: "E_CSP_BLOCKS_EVAL",
      name: "CspBlocksEval",
      message: "eval is blocked in the extension background by the extension's content_security_policy, which allows no unsafe-eval. Engine: webkit",
      engine: "webkit",
    }),
    tool,
  );

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[], _projectPath: string, _timeout?: number, tool?: string) => {
      calls.push(cli);

      if (cli[0] === "eval") return cspRefusal(tool ?? "extension_eval");

      if (cli.includes("--list-tabs")) {
        return JSON.stringify(actFrame("inspect", tabRows([{ id: 4, url: landed, title: "Options" }])));
      }

      if (cli[0] === "navigate") {
        landed = String(cli[1]);

        return envelope({ ok: true, command: "extension_open", status: "ok", value: { tabId: 4, created: true } });
      }

      return envelope({ ok: true, command: tool ?? "extension_open", status: "ok", value: null });
    },
  };
});

const openTool = await import("../tools/open");
const evalTool = await import("../tools/eval");

const UUID = "5E1C7A2B-90D4-4C3E-8F61-2B7A9D04C3E1";
const dirs: string[] = [];

function project(session: { port: number; sessionId: string } | { unavailableReason: string }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-safari-base-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", "safari");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "Rebeccat", background: { scripts: ["background.js"] }, options_ui: { page: "options.html" } }),
  );

  const contract = readyContractPath(dir, "safari");
  fs.mkdirSync(path.dirname(contract), { recursive: true });
  fs.writeFileSync(contract, JSON.stringify(safariDevContract(session, { distPath: dist })));

  return dir;
}

function logLine(dir: string, url: string): void {
  const file = logsPath(dir, "safari");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ level: "log", context: "background", messageParts: ["hi"], url })}\n`);
}

afterEach(() => {
  calls.length = 0;
  landed = "";
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_open asTab on Safari takes the safari-web-extension:// base, never the Gecko route", () => {
  it("opens the options document at the base a log line of this run names", async () => {
    const dir = project({ unavailableReason: "the WebDriver session request failed: timed out" });
    logLine(dir, "https://example.test/");
    logLine(dir, `safari-web-extension://${UUID}/background.html`);

    const result = JSON.parse(await openTool.handler({ projectPath: dir, browser: "safari", surface: "options", asTab: true }));

    expect(result.ok).toBe(true);
    expect(landed).toBe(`safari-web-extension://${UUID}/options.html`);
    expect(result.value.renderedAsTab).toMatchObject({ surface: "options", document: "options.html", extensionId: UUID });
    expect(calls.some((cli) => cli[0] === "eval")).toBe(false);
  });

  it("refuses in Safari words when neither the background nor the log names the base", async () => {
    const dir = project({ unavailableReason: "the WebDriver session request failed: timed out" });

    const result = JSON.parse(await openTool.handler({ projectPath: dir, browser: "safari", surface: "options", asTab: true }));
    const text = JSON.stringify(result);

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NO_EXTENSION_ID");
    expect(result.error.message).toContain("safari-web-extension://");
    expect(result.hint).toContain("safari-web-extension://<uuid>/options.html");
    expect(text).not.toContain("moz-extension");
    expect(text).not.toContain("gecko");
    expect(text).not.toContain("extensions.webextensions.uuids");
    expect(calls.filter((cli) => cli[0] === "eval")).toHaveLength(1);
  });

  it("resolves a bare document url against the same base", async () => {
    const dir = project({ unavailableReason: "n/a" });
    logLine(dir, `safari-web-extension://${UUID}/popup.html`);

    const result = JSON.parse(await openTool.handler({ projectPath: dir, browser: "safari", url: "options.html" }));

    expect(result.ok).toBe(true);
    expect(landed).toBe(`safari-web-extension://${UUID}/options.html`);
  });
});

describe("extension_eval on Safari's background points to the tool that works there", () => {
  it("names extension_storage for storage reads and writes", async () => {
    const dir = project({ port: 1, sessionId: "S-1" });

    const result = JSON.parse(await evalTool.handler({ projectPath: dir, browser: "safari", context: "background", expression: "1" }));

    expect(result.error.code).toBe("E_SAFARI_CONTEXT_UNREACHABLE");
    expect(result.hint).toContain("For storage, call extension_storage (action get or set)");
    expect(result.hint).toContain("extension_open url (the automation window navigates there)");
  });

  it("does not offer the page route when the run has no WebDriver window", async () => {
    const dir = project({ unavailableReason: "the WebDriver session request failed: timed out" });

    const result = JSON.parse(await evalTool.handler({ projectPath: dir, browser: "safari", context: "background", expression: "1" }));

    expect(result.hint).toContain("extension_storage");
    expect(result.hint).toContain("This run has no WebDriver window");
    expect(result.hint).not.toContain("the automation window navigates there");
  });

  it("leaves the storage line off a popup refusal", async () => {
    const dir = project({ port: 1, sessionId: "S-1" });

    const result = JSON.parse(await evalTool.handler({ projectPath: dir, browser: "safari", context: "popup", expression: "1" }));

    expect(result.error.code).toBe("E_SAFARI_CONTEXT_UNREACHABLE");
    expect(result.hint).not.toContain("extension_storage");
  });
});
