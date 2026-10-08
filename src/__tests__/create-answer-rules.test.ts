import { describe, expect, it } from "vitest";

import { answerIsUnknownOutcome } from "../lib/create-answer";

describe("a server error with no platform code comes from in front of the platform while the create may still be running, so its outcome is unknown rather than failed", () => {
  it("reads a bare 5xx as unknown", () => {
    expect(answerIsUnknownOutcome(502, {})).toBe(true);
    expect(answerIsUnknownOutcome(504, "<html>gateway timeout</html>")).toBe(true);
  });

  it("reads a 5xx the platform named as a failure", () => {
    expect(answerIsUnknownOutcome(500, { code: "CLONE_ROLLED_BACK", message: "rolled back" })).toBe(false);
  });

  it("never reads a 4xx as unknown", () => {
    expect(answerIsUnknownOutcome(404, {})).toBe(false);
  });
});
