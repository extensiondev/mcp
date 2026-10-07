import { describe, it, expect } from "vitest";

import * as assertTool from "../tools/assert";

describe("An unknown console context is a refused clause", () => {
  it("answers bad-request naming the engine's contexts, not E_INTERNAL", async () => {
    const result = JSON.parse(
      await assertTool.handler({
        projectPath: "/nonexistent/project",
        expect: [{ assert: "console-errors-empty", context: ["bogus"] }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe("bad-request");
    expect(result.error.code).toBe("E_BAD_REQUEST");
    expect(result.error.message).toContain("expect[0].context");
    expect(result.error.message).toContain("background");
  });

  it("accepts a context the engine knows", async () => {
    const result = JSON.parse(
      await assertTool.handler({
        projectPath: "/nonexistent/project",
        expect: [{ assert: "console-errors-empty", context: ["background"] }],
      }),
    );
    expect(result.status).not.toBe("bad-request");
  });
});
