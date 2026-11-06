import { describe, expect, it } from "vitest";

import { PUSH_COST_SENTENCE, buildAllowanceWarning } from "../lib/build-allowance";
import { CONFIGURED_SKIP_OUTCOMES, SKIP_REQUESTED, skippedPushSentence } from "../lib/head-push";
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
    expect(warning).toMatch(/\[skip build\]/);
    expect(warning).toMatch(/Extension-Build: skip/);
    expect(warning).not.toMatch(/each push spends one/);
  });

  it("the extension_builds description names the skip word outcome beside the settings skips", () => {
    expect(buildsSchema.description).toMatch(/\[skip build\] pushes/);
    expect(JSON.stringify(buildsSchema.inputSchema)).toMatch(/SKIP_REQUESTED for one whose head commit said \[skip build\], \[skip ci\] or Extension-Build: skip/);
  });

  it("a push the head commit opted out of reads as a configured skip with the way back", () => {
    const push = { commit: "abcdef1234567890", outcome: SKIP_REQUESTED, receivedAt: "2026-11-05T21:00:00Z", dispatched: false };

    expect(CONFIGURED_SKIP_OUTCOMES.has(SKIP_REQUESTED)).toBe(true);
    expect(skippedPushSentence(push, "The head")).toBe(
      "The head was pushed (received 2026-11-05T21:00:00Z) and the platform skipped it as SKIP_REQUESTED: its head commit asked for no build ([skip build], [skip ci] or an Extension-Build: skip trailer), so push a commit without that word, or run extension_builds {action: \"rebuild\", buildId: \"abcdef1\"} on it",
    );
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
