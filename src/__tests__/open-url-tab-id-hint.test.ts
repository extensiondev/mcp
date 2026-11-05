import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import { navigateRefusalHint, TAB_ID_HINT } from "../lib/bridge-tabs";
import { actFailure, readyContract } from "./fixtures/engine-answers";

import type * as ActModule from "../lib/act";

const actCalls: string[][] = [];
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      actCalls.push(cli);

      return JSON.stringify(
        actFailure(
          "navigate",
          { name: "FlagValueInvalid", message: "`tab` expects a positive integer, got: 0", code: "E_FLAG_VALUE_INVALID" },
          "usage",
        ),
      );
    },
  };
});

const open = await import("../tools/open");

const dirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-tab-id-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "F" }));

  const readyDir = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify(readyContract("dev", "chrome", { distPath: path.join(dir, "dist", "chrome") })));

  return dir;
}

afterEach(() => {
  actCalls.length = 0;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("398: extension_open refuses a tab that is no chrome.tabs id with a hint about the id, not the control channel", () => {
  it("refuses tab: 0 before the engine is asked and says what tab is", async () => {
    const dir = project();

    const parsed = JSON.parse(await open.handler({ projectPath: dir, url: "http://localhost:3199/me", tab: 0 }));

    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("bad-request");
    expect(parsed.error.code).toBe("E_BAD_REQUEST");
    expect(parsed.error.message).toContain("chrome.tabs id");
    expect(parsed.error.message).toContain("got: 0");
    expect(parsed.hint).toBe(TAB_ID_HINT);
    expect(parsed.hint).toContain("not a tab position");
    expect(parsed.hint).toContain("listTabs: true");
    expect(parsed.hint).not.toMatch(/control channel/);
    expect(actCalls).toHaveLength(0);
  });

  it("refuses a fractional and a negative tab the same way", async () => {
    const dir = project();

    for (const tab of [1.5, -3]) {
      const parsed = JSON.parse(await open.handler({ projectPath: dir, url: "https://a.test/", tab }));

      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("E_BAD_REQUEST");
      expect(parsed.hint).toBe(TAB_ID_HINT);
    }

    expect(actCalls).toHaveLength(0);
  });

  it("names the tab id when the engine itself refuses the tab argument, and the control channel only for a session refusal", () => {
    expect(navigateRefusalHint({ status: "usage", error: { code: "E_FLAG_VALUE_INVALID", message: "`tab` expects a positive integer, got: 0" } })).toBe(TAB_ID_HINT);
    expect(navigateRefusalHint({ status: "usage", error: { code: "E_FLAG_VALUE_INVALID", message: "--timeout expects a positive integer, got: x" } })).toMatch(/arguments, not the session/);
    expect(navigateRefusalHint({ status: "failed", error: { code: "E_BRIDGE_UNAVAILABLE", message: "no control channel" } })).toMatch(/control channel/);
  });

  it("the tab schema says it is a chrome.tabs id and not a position", () => {
    const tab = (open.schema.inputSchema.properties as Record<string, { description: string }>).tab;

    expect(tab.description).toMatch(/not a tab position/);
    expect(tab.description).toMatch(/0 is not the first tab/);
    expect(tab.description).toMatch(/listTabs: true/);
  });
});
