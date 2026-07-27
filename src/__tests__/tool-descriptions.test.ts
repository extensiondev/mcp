import { describe, expect, it } from "vitest";

import { tools as ALL_TOOLS } from "../index";

const IMPERATIVE_VERBS = [
  "Analyze",
  "Browse",
  "Build",
  "Create",
  "Diagnose",
  "Evaluate",
  "Find",
  "Inspect",
  "List",
  "Open",
  "Plan",
  "Preview",
  "Promote",
  "Publish",
  "Read",
  "Reload",
  "Run",
  "Sign",
  "Stop",
  "Submit",
  "Take",
  "Validate",
  "Verify",
  "Wait",
];

const ACRONYMS_ARE_NAMES_NOT_EMPHASIS = new Set([
  "AMO",
  "CDP",
  "CI",
  "CLI",
  "CSP",
  "CSS",
  "D1",
  "D3",
  "D4",
  "DOM",
  "EXTENSION_DEV_TOKEN",
  "HTML",
  "MB",
  "MV2",
  "MV3",
  "PR",
  "RDP",
  "UI",
  "URL",
  "WYSIWYG",
]);

const EMPHASIS_BUDGET = 1;

const emphasisRuns = (description: string): string[] => {
  const words = [...description.matchAll(/\b[A-Z][A-Z0-9_]+\b/g)];
  const runs: string[] = [];
  let previousEnd = -1;
  for (const match of words) {
    const word = match[0];
    if (ACRONYMS_ARE_NAMES_NOT_EMPHASIS.has(word)) {
      previousEnd = -1;
      continue;
    }
    const start = match.index as number;
    const contiguous =
      previousEnd >= 0 && description.slice(previousEnd, start).trim() === "";
    if (contiguous) {
      runs[runs.length - 1] = `${runs[runs.length - 1]} ${word}`;
    } else {
      runs.push(word);
    }
    previousEnd = start + word.length;
  }
  return runs;
};

describe("every tool description is the first thing an agent reads about a tool, so it follows the CLI's own command-help copy rules", () => {
  for (const tool of ALL_TOOLS) {
    const { name, description } = tool.schema;

    it(`${name} opens with an imperative verb`, () => {
      const first = description.split(/\s+/)[0].replace(/[,:]$/, "");
      expect(
        IMPERATIVE_VERBS,
        `${name} opens with "${first}", which is not an approved imperative verb`,
      ).toContain(first);
    });

    it(`${name} ends its last sentence with a period`, () => {
      expect(description.trimEnd().endsWith(".")).toBe(true);
    });

    it(`${name} writes an ellipsis as a single character`, () => {
      expect(description).not.toContain("...");
    });

    it(`${name} spells the brand Extension.js`, () => {
      expect(/\bextension\.js\b/.test(description)).toBe(false);
    });

    it(`${name} shouts at most once, only on the word that separates it from the neighbour it is confused with`, () => {
      const runs = emphasisRuns(description);
      expect(
        runs.length,
        `${name} shouts ${runs.length} times (${runs.join(", ")}); carry the rest as "Use <other tool> for X"`,
      ).toBeLessThanOrEqual(EMPHASIS_BUDGET);
    });
  }

  it("keeps the whole surface under a handful of shouted words", () => {
    const total = ALL_TOOLS.reduce(
      (sum, tool) => sum + emphasisRuns(tool.schema.description).length,
      0,
    );
    expect(total).toBeLessThanOrEqual(8);
  });
});
