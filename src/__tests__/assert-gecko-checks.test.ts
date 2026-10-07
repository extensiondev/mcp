import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelope } from "../lib/envelope";
import { actFrame, cliRefusal, tabRows } from "./fixtures/engine-answers";

const actCalls: string[][] = [];
let controlChannel: "answers" | "silent" = "answers";
const listTabsReply = (): string =>
  JSON.stringify(
    controlChannel === "answers"
      ? actFrame("inspect", tabRows([{ id: 1, url: "about:blank", title: "New Tab" }]))
      : cliRefusal(
          "inspect",
          "E_SESSION_NOT_FOUND",
          "No active control channel found for firefox. Looked at /tmp/project/dist/extension-js/firefox/ready.json. Run `extension dev --browser=firefox --allow-control` first.",
        ),
  );
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
      if (cli.includes("--list-tabs")) return listTabsReply();
      return inspectReply();
    },
  };
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
  controlChannel = "answers";
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
  it("passes background-worker-booted when the bridge answers a tabs query with the engine's tab rows", async () => {
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
    expect(leg.evidence?.tabsSeen ?? leg.details?.tabsSeen ?? leg.tabsSeen).toBe(1);
    expect(actCalls[0]).toEqual(expect.arrayContaining(["inspect", "--list-tabs", "--browser", "firefox"]));
  });

  it("stays inconclusive on the background when the CLI refuses with its no-control-channel frame", async () => {
    controlChannel = "silent";

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
