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

  it("says a release needs an owner's token and an owner's approval every time", () => {
    expect(promote.description).toContain("A release needs a token minted by a workspace owner and a workspace owner's approval of that exact release, every time");
    expect(approvalIdOf(promote)).toContain("every release needs a workspace owner's approval");
  });

  it("never says a member may approve a promote", () => {
    for (const said of [promote.description, approvalIdOf(promote)]) {
      expect(said).not.toMatch(/any member/i);
    }
  });

  it("says a real submission needs an owner's approval every time", () => {
    expect(submit.description).toContain("a workspace owner's token and approval of that exact submission, every time");
    expect(approvalIdOf(submit)).toContain("needs a workspace owner's approval every time");
  });
});
