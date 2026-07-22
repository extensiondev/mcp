import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const calls: string[][] = [];
let reply: () => string = () => JSON.stringify({ ok: true, value: 42 });
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      calls.push(cli);
      return reply();
    },
  };
});

const evalTool = await import("../tools/eval");
const { toMcpSpeak } = await import("../lib/act");

const dirs: string[] = [];
function project(manifests: Record<string, Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-default-"));
  dirs.push(dir);
  for (const [rel, manifest] of Object.entries(manifests)) {
    const file = path.join(dir, rel, "manifest.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(manifest));
  }
  return dir;
}

afterEach(() => {
  calls.length = 0;
  reply = () => JSON.stringify({ ok: true, value: 42 });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// Swarm C20: the default template is a Chromium MV3 service worker, whose CSP
// blocks eval, so a background default made the defaults-only call fail on
// the most common path. The default must land somewhere that works.
describe("eval default context", () => {
  it("defaults to page on a Chromium MV3 session and says why", async () => {
    const dir = project({
      "dist/chrome": { manifest_version: 3, name: "F", background: { service_worker: "background.js" } },
    });

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, expression: "1 + 1", browser: "chrome" }),
    );

    const idx = calls[0].indexOf("--context");
    expect(idx).toBeGreaterThan(-1);
    expect(calls[0][idx + 1]).toBe("page");
    expect(result.ok).toBe(true);
    expect(result.defaultedContext).toBe("page");
    expect(result.contextNote).toContain("CSP");
    expect(result.contextNote).toContain('context: "background"');
  });

  it("leaves an explicit background context untouched on Chromium MV3", async () => {
    const dir = project({
      "dist/chrome": { manifest_version: 3, name: "F", background: { service_worker: "background.js" } },
    });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        expression: "1 + 1",
        browser: "chrome",
        context: "background",
      }),
    );

    const idx = calls[0].indexOf("--context");
    expect(calls[0][idx + 1]).toBe("background");
    expect(result.defaultedContext).toBeUndefined();
    expect(result.contextNote).toBeUndefined();
  });

  it("keeps the CLI background default on Firefox", async () => {
    const dir = project({
      "dist/firefox": { manifest_version: 2, name: "F", background: { scripts: ["background.js"] } },
    });

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, expression: "1 + 1", browser: "firefox" }),
    );

    expect(calls[0]).not.toContain("--context");
    expect(result.defaultedContext).toBeUndefined();
  });

  it("keeps the background default on a Chromium MV2 build", async () => {
    const dir = project({
      "dist/chrome": { manifest_version: 2, name: "F", background: { scripts: ["background.js"] } },
    });

    await evalTool.handler({ projectPath: dir, expression: "1 + 1", browser: "chrome" });

    expect(calls[0]).not.toContain("--context");
  });

  it("reads the prefixed source manifest when nothing is built yet", async () => {
    const dir = project({
      src: { "chromium:manifest_version": 3, "firefox:manifest_version": 2, name: "F" },
    });

    await evalTool.handler({ projectPath: dir, expression: "1 + 1", browser: "chrome" });

    const idx = calls[0].indexOf("--context");
    expect(calls[0][idx + 1]).toBe("page");
  });

  it("keeps the background default when no manifest is readable", async () => {
    const dir = project({});

    await evalTool.handler({ projectPath: dir, expression: "1 + 1", browser: "chrome" });

    expect(calls[0]).not.toContain("--context");
  });

  it("explains an unreachable active tab on the defaulted path", async () => {
    const dir = project({
      "dist/chrome": { manifest_version: 3, name: "F", background: { service_worker: "background.js" } },
    });
    reply = () =>
      JSON.stringify({
        ok: false,
        error: {
          name: "EvalError",
          message: "Cannot access a chrome-extension:// URL of different extension",
        },
      });

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, expression: "1 + 1", browser: "chrome" }),
    );

    expect(result.ok).toBe(false);
    expect(result.defaultedContext).toBe("page");
    expect(result.hint).toContain("Navigate the dev browser");
    expect(result.hint).toContain("listTabs: true");
  });

  it("resolves the rule directly", () => {
    const mv3 = project({ "dist/chrome": { manifest_version: 3 } });
    const mv2 = project({ "dist/chrome": { manifest_version: 2 } });

    expect(evalTool.resolveDefaultEvalContext(mv3, "chrome")).toBe("page");
    expect(evalTool.resolveDefaultEvalContext(mv3, "firefox")).toBe("background");
    expect(evalTool.resolveDefaultEvalContext(mv2, "chrome")).toBe("background");
  });
});

// Swarm C20: engine remedies leaked raw CLI flag syntax (--tab) into MCP
// JSON errors. Every remedy must speak tool-arg vocabulary.
describe("eval error prose speaks tool args, not CLI flags", () => {
  it("rewrites the MV3 CSP remedy without leaking --tab", () => {
    const engine =
      "eval is blocked in the MV3 service worker by CSP. Use --context page --tab <id> (eval runs in the page's MAIN world), or run on an MV2/Firefox build. Engine: 4.0.14";
    const out = toMcpSpeak(engine);

    expect(out).toContain('context: "page"');
    expect(out).not.toContain("--tab");
    expect(out).not.toContain("--context");
  });

  it("rewrites the no-target remedy without garbling the url clause", () => {
    const engine =
      "eval/inspect in context content needs a --tab id, a --url to match, or an active tab";
    const out = toMcpSpeak(engine);

    expect(out).toBe(
      "eval/inspect in context content needs a `tab` id, a `url` to match, or an active tab",
    );
  });

  it("rewrites any bare flag mention as the arg name", () => {
    expect(toMcpSpeak("inspect a content/page (with --tab) or an open surface")).toBe(
      "inspect a content/page (with `tab`) or an open surface",
    );
    expect(toMcpSpeak("pass --url or --context to choose")).toBe(
      "pass `url` or `context` to choose",
    );
  });

  it("still rewrites valued flags to JSON args", () => {
    expect(toMcpSpeak("retry with --tab 7")).toBe("retry with tab: 7");
    expect(toMcpSpeak("retry with --url https://a.dev/*")).toBe(
      'retry with url: "https://a.dev/*"',
    );
  });
});
