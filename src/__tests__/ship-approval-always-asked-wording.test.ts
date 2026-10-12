import { describe, expect, it } from "vitest";

import { schema as promote } from "../tools/release-promote";
import { schema as submit } from "../tools/submit";

const approvalIdOf = (tool: { inputSchema: { properties: Record<string, unknown> } }) =>
  String((tool.inputSchema.properties.approvalId as { description: string }).description);

describe("a token promote and a real submission always ask a human", () => {
  it("never says the approval depends on a gate being on", () => {
    for (const said of [promote.description, approvalIdOf(promote), submit.description, approvalIdOf(submit)]) {
      expect(said).not.toMatch(/gate is on/);
    }
  });

  it("says a promote needs an owner's token and a human approval every time", () => {
    expect(promote.description).toContain("A promote needs a token minted by a workspace owner and a human approval of that exact promote, every time");
    expect(approvalIdOf(promote)).toContain("every promote needs a human approval");
  });

  it("says a real submission needs an owner's approval every time", () => {
    expect(submit.description).toContain("and a workspace owner's approval of that exact submission, every time");
    expect(approvalIdOf(submit)).toContain("needs a workspace owner's approval every time");
  });
});
