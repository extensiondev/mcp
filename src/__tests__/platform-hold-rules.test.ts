import { describe, expect, it } from "vitest";

import { PLATFORM_HOLD_CODE, PLATFORM_HOLD_HEADER, sawPlatformHold } from "../lib/platform-hold";

const withHeader = (value: string | null) => ({
  headers: { get: (name: string) => (name === PLATFORM_HOLD_HEADER ? value : null) },
});

describe("the hold signal is the platform's code or the edge header set to held, never the sentence and never the header's mere presence", () => {
  it("reads the machine code in the body", () => {
    expect(sawPlatformHold(withHeader(null), { code: PLATFORM_HOLD_CODE })).toBe(true);
  });

  it("reads the header only when it says held", () => {
    expect(sawPlatformHold(withHeader("held"), null)).toBe(true);
    expect(sawPlatformHold(withHeader("operator-enroll"), null)).toBe(false);
  });

  it("ignores a refusal sentence with no code", () => {
    expect(sawPlatformHold(withHeader(null), { message: "extension.dev is not open to the public yet." })).toBe(false);
  });
});
