import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelope } from "../lib/envelope";

const actCalls: string[][] = [];
let inspectReply: () => string = () =>
  envelope({
    ok: true,
    command: "extension_assert",
    status: "ok",
    value: { context: "newtab", url: "moz-extension://abc/newtab/index.html", title: "NT", summary: { bodyChildCount: 4 } },
  });
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      actCalls.push(cli);
      return inspectReply();
    },
  };
});

let bridgeTabs: { tabs: Array<{ tabId: number; url: string; title: string }> } | { error: string } = {
  tabs: [{ tabId: 1, url: "about:blank", title: "New Tab" }],
};
vi.mock("../lib/bridge-tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bridge-tabs")>();
  return { ...actual, listBridgeTabs: async () => bridgeTabs };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return { ...actual, resolveCdpPort: async () => null, resolveRdpPort: async () => null };
});

const assertTool = await import("../tools/assert");

const dirs: string[] = [];
function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-assert-gecko-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", "firefox");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, "manifest.json"),
    JSON.stringify({
      manifest_version: 2,
      name: "F",
      background: { scripts: ["bg.js"] },
      chrome_url_overrides: { newtab: "newtab/index.html" },
    }),
  );
  return dir;
}

function check(result: any, id: string) {
  return result.value.checks.find((c: { assert?: string; id?: string; check?: string }) =>
    [c.assert, c.id, c.check].includes(id),
  );
}

afterEach(() => {
  actCalls.length = 0;
  bridgeTabs = { tabs: [{ tabId: 1, url: "about:blank", title: "New Tab" }] };
  inspectReply = () =>
    envelope({
      ok: true,
      command: "extension_assert",
      status: "ok",
      value: { context: "newtab", url: "moz-extension://abc/newtab/index.html", title: "NT", summary: { bodyChildCount: 4 } },
    });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_assert reads Gecko through the control channel instead of answering inconclusive", () => {
  it("passes background-worker-booted when the bridge answers a tabs query", async () => {
    const result = JSON.parse(
      await assertTool.handler({
        projectPath: project(),
        browser: "firefox",
        expect: [{ assert: "background-worker-booted" }],
      }),
    );
    const leg = check(result, "background-worker-booted");

    expect(leg.outcome ?? leg.status ?? leg.verdict).toMatch(/pass/i);
    expect(JSON.stringify(leg)).toContain("control channel");
    expect(JSON.stringify(leg)).not.toContain("exposes no such list");
  });

  it("stays inconclusive on the background when the control channel is silent", async () => {
    bridgeTabs = { error: "no control channel" };

    const result = JSON.parse(
      await assertTool.handler({
        projectPath: project(),
        browser: "firefox",
        expect: [{ assert: "background-worker-booted" }],
      }),
    );
    const leg = check(result, "background-worker-booted");

    expect(leg.outcome ?? leg.status ?? leg.verdict).toMatch(/inconclusive/i);
    expect(JSON.stringify(leg)).toContain("allowControl");
  });

  it("passes surface-rendered when the surface relay answers with a document", async () => {
    const result = JSON.parse(
      await assertTool.handler({
        projectPath: project(),
        browser: "firefox",
        expect: [{ assert: "surface-rendered", surface: "newtab" }],
      }),
    );
    const leg = check(result, "surface-rendered");

    expect(leg.outcome ?? leg.status ?? leg.verdict).toMatch(/pass/i);
    expect(actCalls[0][0]).toBe("inspect");
    expect(actCalls[0][actCalls[0].indexOf("--context") + 1]).toBe("newtab");
    expect(JSON.stringify(leg)).toContain("4 body child elements");
  });

  it("fails surface-rendered when the relay has no open document to answer from", async () => {
    inspectReply = () =>
      envelope({
        ok: false,
        command: "extension_assert",
        status: "not-found",
        error: { code: "E_TARGET_NOT_FOUND", name: "Unsupported", message: "surface 'newtab' is not open" },
      });

    const result = JSON.parse(
      await assertTool.handler({
        projectPath: project(),
        browser: "firefox",
        expect: [{ assert: "surface-rendered", surface: "newtab" }],
      }),
    );
    const leg = check(result, "surface-rendered");

    expect(leg.outcome ?? leg.status ?? leg.verdict).toMatch(/fail/i);
    expect(JSON.stringify(leg)).toContain("nothing is rendering it");
  });

  it("keeps a selector clause inconclusive on Gecko and names the tool that reads it", async () => {
    const result = JSON.parse(
      await assertTool.handler({
        projectPath: project(),
        browser: "firefox",
        expect: [{ assert: "surface-rendered", surface: "newtab", selector: "#root" }],
      }),
    );
    const leg = check(result, "surface-rendered");

    expect(leg.outcome ?? leg.status ?? leg.verdict).toMatch(/inconclusive/i);
    expect(JSON.stringify(leg)).toContain("extension_inspect");
  });
});
