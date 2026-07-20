import { describe, it, expect, afterEach, vi } from "vitest";
import { normalizeArgAliases, validateToolInput } from "../lib/validate-input";

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

afterEach(() => {
  calls.length = 0;
});

describe("arg aliases", () => {
  const schema = {
    type: "object",
    properties: {
      timeout: { type: "number" },
      limit: { type: "number" },
      tab: { type: "number" },
    },
  };

  it("folds timeoutMs onto timeout", () => {
    expect(normalizeArgAliases(schema, { timeoutMs: 9000 })).toEqual({
      timeout: 9000,
    });
  });

  it("folds lines onto limit", () => {
    expect(normalizeArgAliases(schema, { lines: 20 })).toEqual({ limit: 20 });
  });

  it("folds tabId onto tab", () => {
    expect(normalizeArgAliases(schema, { tabId: 3 })).toEqual({ tab: 3 });
  });

  it("leaves the canonical name alone when already supplied", () => {
    expect(normalizeArgAliases(schema, { timeout: 1, timeoutMs: 2 })).toEqual({
      timeout: 1,
      timeoutMs: 2,
    });
  });

  it("does not rewrite when the tool owns the alias word", () => {
    const owns = {
      type: "object",
      properties: { timeout: { type: "number" }, timeoutMs: { type: "number" } },
    };
    expect(normalizeArgAliases(owns, { timeoutMs: 5 })).toEqual({
      timeoutMs: 5,
    });
  });
});

describe("union types in the input validator", () => {
  const schema = {
    type: "object" as const,
    properties: { withConsole: { type: ["number", "boolean"] } },
  };

  it("accepts either member of the union", () => {
    expect(validateToolInput(schema, { withConsole: 20 })).toEqual([]);
    expect(validateToolInput(schema, { withConsole: true })).toEqual([]);
  });

  it("still rejects a type outside the union", () => {
    const issues = validateToolInput(schema, { withConsole: "yes" });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe("expected number or boolean, got string");
  });
});

describe("withConsole coercion", () => {
  it("treats true as a sensible line count", async () => {
    await domInspect.handler({
      projectPath: "/p",
      context: "content",
      withConsole: true,
    });

    expect(calls[0][calls[0].indexOf("--with-console") + 1]).toBe("50");
  });

  it("passes a number through unchanged", async () => {
    await domInspect.handler({
      projectPath: "/p",
      context: "content",
      withConsole: 5,
    });

    expect(calls[0][calls[0].indexOf("--with-console") + 1]).toBe("5");
  });

  it("omits the flag for false", async () => {
    await domInspect.handler({
      projectPath: "/p",
      context: "content",
      withConsole: false,
    });

    expect(calls[0]).not.toContain("--with-console");
  });
});
