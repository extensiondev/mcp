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
