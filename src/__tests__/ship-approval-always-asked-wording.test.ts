import { describe, expect, it } from "vitest";

import { TOOL_DOCS } from "../lib/docs-meta";
import { schema as promote } from "../tools/release-promote";
import { schema as shares } from "../tools/shares";
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
    expect(promote.description).toContain("A release needs a workspace owner's token and approval of that exact release, every time");
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

  it("785: says a share revoke needs a member's approval, the role the platform asks, never an owner's", () => {
    expect(shares.description).toContain("A revoke is permanent and needs a workspace member's approval.");
    expect(`${shares.description} ${TOOL_DOCS.extension_shares.gate}`).not.toMatch(/owner/i);
    expect(TOOL_DOCS.extension_shares.gate).toContain("a revoke waits for a workspace member's approval");
  });

  it("798: the gate line of every act names the role the platform's approval catalog asks", () => {
    const gates = Object.fromEntries(Object.entries(TOOL_DOCS).map(([tool, docs]) => [tool, docs.gate]));

    expect(gates.extension_release_promote).toContain("every release, cut and rollback needs a workspace owner's approval");
    expect(gates.extension_publish).toContain("sync-captures needs a workspace owner's approval, and a link to a private project a workspace member's");
    expect(gates.extension_submit).toContain("need a workspace owner's approval");
    expect(gates.extension_builds_act).toContain("a public channel audience needs a workspace owner's approval");
    expect(gates.extension_workspace).toContain("a public visibility needs a workspace owner's approval");
    expect(gates.extension_shares).toContain("a revoke waits for a workspace member's approval");
  });
});
