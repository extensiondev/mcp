import { describe, expect, it } from "vitest";
import { makeFilter } from "../tools/logs-filter";
import { validateToolInput } from "../lib/validate-input";
import { schema as logsSchema } from "../tools/logs";

describe("extension_logs level: off", () => {
  it("matches zero console events, because off means logging disabled", () => {
    const matches = makeFilter({ projectPath: "/p", level: "off" });
    expect(
      matches({ context: "background", level: "error", message: "boom" }),
    ).toBe(false);
    expect(
      matches({ context: "content", level: "info", message: "hi" }),
    ).toBe(false);
    expect(matches({ context: "popup", level: "trace" })).toBe(false);
  });

  it("still passes structured dx.signal diagnostics at level off", () => {
    const matches = makeFilter({ projectPath: "/p", level: "off" });
    expect(
      matches({
        context: "background",
        eventType: "dx.signal",
        level: "info",
      }),
    ).toBe(true);
  });

  it("keeps all and severity thresholds unchanged", () => {
    const all = makeFilter({ projectPath: "/p", level: "all" });
    expect(all({ context: "background", level: "trace" })).toBe(true);
    const warn = makeFilter({ projectPath: "/p", level: "warn" });
    expect(warn({ context: "background", level: "error" })).toBe(true);
    expect(warn({ context: "background", level: "info" })).toBe(false);
  });
});

describe("extension_logs context enum", () => {
  it("accepts every context the engine emits, including override pages", () => {
    for (const context of ["newtab", "history", "bookmarks"]) {
      expect(
        validateToolInput(logsSchema.inputSchema, {
          projectPath: "/p",
          context: [context],
        }),
      ).toEqual([]);
    }
  });
});
