// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { schema } from "../tools/submit";

const IN_PROGRESS_SUBMISSION =
  "InProgressSubmission: Can't publish extension as your extension submission is in progress. Please try again later.";

describe("extension_submit tells the agent what Edge does while a submission is in certification review", () => {
  const description = String(schema.description);
  const action = String((schema.inputSchema.properties as Record<string, { description?: string }>).action.description);

  it("names the platform's edgePreflight rules, the lock a review in progress sets, and that a locked publish is queued, never failed", () => {
    expect(action).toContain("edgePreflight");
    expect(action).toContain("{id, severity blocking or warn, lock?}");
    expect(action).toContain(IN_PROGRESS_SUBMISSION);
    expect(action).toMatch(/queued behind that review, never failed/);
    expect(action).toMatch(/never cancels it/);
  });

  it("says an Edge upload during a review replaces the draft only, and that the approval names what the act does to what is in flight", () => {
    expect(action).toMatch(/upload while a submission is in certification review replaces the draft package only/);
    expect(action).toContain("edgePreflight.approval");
    expect(description).toContain("Edge Add-ons");
  });
});
