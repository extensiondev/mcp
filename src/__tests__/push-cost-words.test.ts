import { describe, expect, it } from "vitest";

import { PUSH_COST_SENTENCE, buildAllowanceWarning } from "../lib/build-allowance";
import { schema as buildsSchema } from "../tools/builds";
import { schema as workspaceSchema } from "../tools/workspace";

describe("426: what a push costs is said with its filters, never as a blanket rule", () => {
  it("the allowance warning names the build branch, the root directory and the docs-only filter", () => {
    const warning = buildAllowanceWarning({ used: 345, limit: 350, remaining: 5, low: true }) ?? "";

    expect(warning).toContain("5 builds remain of 350 this month");
    expect(warning).toContain(PUSH_COST_SENTENCE);
    expect(warning).toMatch(/build branch/);
    expect(warning).toMatch(/root directory/);
    expect(warning).toMatch(/docs/);
    expect(warning).toMatch(/spends nothing/);
    expect(warning).not.toMatch(/each push spends one/);
  });

  it("the extension_workspace and extension_builds descriptions name the filters an agent plans pushes by", () => {
    for (const description of [workspaceSchema.description, buildsSchema.description]) {
      expect(description).toMatch(/build branch/);
      expect(description).toMatch(/root directory/);
      expect(description).toMatch(/docs-only/);
      expect(description).toMatch(/spend nothing/);
    }
  });
});
