import { describe, expect, it } from "vitest";

import { schema } from "../tools/add-feature";

const ASKS = [
  "an options page",
  "a popup",
  "a side panel",
  "a content script",
  "a devtools panel",
  "a new tab page",
];

describe("extension_add_feature's description is the trigger for a plain add-a-surface ask", () => {
  it("keeps its description short so it costs little context", () => {
    expect(schema.description.split(/\s+/).length).toBeLessThan(70);
  });

  it.each(ASKS)("names %s as an ask it answers", (ask) => {
    expect(schema.description).toContain(ask);
  });

  it("says it plans the surface before the agent writes it, and that the agent writes what the plan says", () => {
    expect(schema.description).toMatch(/^Plan the surface before adding/);
    expect(schema.description).toMatch(/write what the plan says/);
  });

  it("hands the follow-up to the manifest check and the dev session instead of leaving the agent to shell out", () => {
    expect(schema.description).toMatch(/validate the manifest and run extension_dev/);
  });
});
