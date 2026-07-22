import { describe, it, expect, afterEach, vi } from "vitest";

const calls: string[][] = [];
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      calls.push(cli);
      return JSON.stringify({ ok: true });
    },
  };
});

const domInspect = await import("../tools/dom-inspect");
const evalTool = await import("../tools/eval");
const openTool = await import("../tools/open");

afterEach(() => {
  calls.length = 0;
});

describe("dom_inspect targeting", () => {
  // Upstream #51 made url a first-class selector with an active-tab default.
  // dom_inspect used to refuse content/page without a numeric tab id, which
  // blocked the path that now works.
  it("no longer demands a tab id for content", async () => {
    const result = JSON.parse(
      await domInspect.handler({ projectPath: "/p", context: "content" }),
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("inspect");
    expect(calls[0]).not.toContain("--tab");
  });

  it("passes url through as the target selector", async () => {
    await domInspect.handler({
      projectPath: "/p",
      context: "content",
      url: "https://example.com",
    });

    expect(calls[0]).toContain("--url");
    expect(calls[0][calls[0].indexOf("--url") + 1]).toBe("https://example.com");
  });

  it("still honours an explicit tab id", async () => {
    await domInspect.handler({ projectPath: "/p", context: "page", tab: 7 });

    expect(calls[0][calls[0].indexOf("--tab") + 1]).toBe("7");
  });

  it("listTabs is a discovery call that ignores the other args", async () => {
    await domInspect.handler({
      projectPath: "/p",
      listTabs: true,
      context: "content",
      tab: 7,
    });

    expect(calls[0]).toContain("--list-tabs");
    expect(calls[0]).not.toContain("--tab");
    expect(calls[0]).not.toContain("--context");
  });
});

describe("eval targeting", () => {
  it("forwards url without requiring a tab id", async () => {
    await evalTool.handler({
      projectPath: "/p",
      expression: "document.title",
      context: "content",
      url: "https://example.com",
    });

    expect(calls[0]).toContain("--url");
    expect(calls[0]).not.toContain("--tab");
  });

  it("sends neither selector when targeting the active tab", async () => {
    await evalTool.handler({
      projectPath: "/p",
      expression: "1 + 1",
      context: "content",
    });

    expect(calls[0]).not.toContain("--url");
    expect(calls[0]).not.toContain("--tab");
  });
});

// L9: extension_open surface:"command" used to fire a command that the manifest
// never declares, returning a green "triggered" for a shortcut that can only
// ever be a no-op.
describe("open command validates against the manifest", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");

  const dirs: string[] = [];
  function projectWithCommands(commands: Record<string, unknown> | undefined) {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "mcp-open-cmd-"));
    dirs.push(dir);
    fs.mkdirSync(nodePath.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      nodePath.join(dir, "src", "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "F", ...(commands ? { commands } : {}) }),
    );
    return dir;
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("refuses an undeclared command and lists the real ones", async () => {
    const dir = projectWithCommands({ "toggle-speed": { suggested_key: {} } });

    const result = JSON.parse(
      await openTool.handler({ projectPath: dir, surface: "command", name: "toggle-sped" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("UnknownCommand");
    expect(result.declaredCommands).toEqual(["toggle-speed"]);
    expect(calls).toHaveLength(0);
  });

  it("allows a declared command through", async () => {
    const dir = projectWithCommands({ "toggle-speed": { suggested_key: {} } });

    await openTool.handler({ projectPath: dir, surface: "command", name: "toggle-speed" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--name");
  });

  it("says so when the manifest declares no commands at all", async () => {
    const dir = projectWithCommands(undefined);

    const result = JSON.parse(
      await openTool.handler({ projectPath: dir, surface: "command", name: "anything" }),
    );

    expect(result.ok).toBe(false);
    expect(result.hint).toContain("no commands at all");
  });
});

// Opening the popup of an extension whose manifest sets no action.default_popup
// used to hand back the engine's raw openPopup rejection, which reads as a
// broken session rather than a fact about the extension. The tool must say
// what is absent, where it would be declared, and what verb works instead,
// without ever spawning the CLI for a popup that cannot exist.
describe("open popup validates against the manifest", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");

  const dirs: string[] = [];
  function projectWithManifest(manifest: Record<string, unknown>) {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "mcp-open-popup-"));
    dirs.push(dir);
    fs.mkdirSync(nodePath.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      nodePath.join(dir, "src", "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "F", ...manifest }),
    );
    return dir;
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("explains a popup-less extension instead of relaying the engine error", async () => {
    const dir = projectWithManifest({ options_ui: { page: "options.html" } });

    const result = JSON.parse(
      await openTool.handler({ projectPath: dir, surface: "popup" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NoSurfaceDocument");
    expect(result.error.message).toContain("declares no popup");
    expect(result.error.message).toContain("action.default_popup");
    expect(result.declaredSurfaces).toEqual(["options"]);
    expect(result.hint).toContain('surface: "action"');
    expect(calls).toHaveLength(0);
  });

  it("lets a declared popup through to the engine", async () => {
    const dir = projectWithManifest({ action: { default_popup: "popup.html" } });

    await openTool.handler({ projectPath: dir, surface: "popup" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("popup");
  });

  it("does not block on a guess when no manifest is readable", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "mcp-open-popup-"));
    dirs.push(dir);

    await openTool.handler({ projectPath: dir, surface: "popup" });

    expect(calls).toHaveLength(1);
  });
});
