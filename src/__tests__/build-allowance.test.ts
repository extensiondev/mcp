import { describe, expect, it } from "vitest";

import {
  LOW_BUILDS_REMAINING,
  LOW_BUILDS_SHARE,
  buildAllowanceValue,
  buildAllowanceWarning,
  buildsRunLow,
  firstBuildSpendNarration,
  readBuildAllowance,
} from "../lib/build-allowance";

const plan = (buildsThisMonth: number, buildsPerMonth: number) => ({
  plan: "pro",
  limits: { buildsPerMonth, projects: 10 },
  used: { buildsThisMonth, projects: 4 },
});

describe("the shared low-builds threshold", () => {
  it("is under ten remaining or under five percent of the allowance", () => {
    expect(LOW_BUILDS_REMAINING).toBe(10);
    expect(LOW_BUILDS_SHARE).toBe(0.05);
    expect(buildsRunLow(9, 100)).toBe(true);
    expect(buildsRunLow(10, 100)).toBe(false);
    expect(buildsRunLow(17, 350)).toBe(true);
    expect(buildsRunLow(18, 350)).toBe(false);
    expect(buildsRunLow(49, 1000)).toBe(true);
    expect(buildsRunLow(50, 1000)).toBe(false);
    expect(buildsRunLow(0, 25)).toBe(true);
  });

  it("reads the plan's counters the workspace tool reads, and nothing it cannot count", () => {
    expect(readBuildAllowance(plan(342, 350))).toEqual({ used: 342, limit: 350, remaining: 8, low: true });
    expect(readBuildAllowance(plan(4, 350))).toEqual({ used: 4, limit: 350, remaining: 346, low: false });
    expect(readBuildAllowance(plan(360, 350))?.remaining).toBe(0);
    expect(readBuildAllowance({ limits: { buildsPerMonth: 350 }, used: null })).toBeNull();
    expect(readBuildAllowance({ limits: { buildsPerMonth: 0 }, used: { buildsThisMonth: 0 } })).toBeNull();
    expect(readBuildAllowance({ limits: {}, used: { buildsThisMonth: "4" } })).toBeNull();
    expect(readBuildAllowance(null)).toBeNull();
  });

  it("warns only when the count runs low, naming what spends one", () => {
    const low = readBuildAllowance(plan(342, 350))!;
    const fine = readBuildAllowance(plan(4, 350))!;

    expect(buildAllowanceWarning(low)).toBe("8 builds remain of 350 this month; each project creation and each push spends one.");
    expect(buildAllowanceWarning(readBuildAllowance(plan(349, 350))!)).toContain("1 build remains of 350");
    expect(buildAllowanceWarning(fine)).toBeNull();
    expect(buildAllowanceValue(low)).toEqual({ used: 342, limit: 350, remaining: 8, warning: expect.stringContaining("8 builds remain") });
    expect(buildAllowanceValue(fine).warning).toBeNull();
  });
});

describe("the first build's spend narration", () => {
  it("keeps the never-invents sentence when no count was read, and adds that the first build spent one", () => {
    const spent = firstBuildSpendNarration({ what: "This project creation, including its first build,", dispatched: true, before: null });

    expect(spent.remains).toContain("never invents one");
    expect(spent.remains).toContain("The first build spent one of the month's allowance");
    expect(spent.remains).toContain("extension_workspace (action: info)");
    expect(spent.remaining).toBeUndefined();
    expect(spent.warning).toBeUndefined();

    const withheld = firstBuildSpendNarration({ what: "This project creation, with no first build dispatched,", dispatched: false, before: null });

    expect(withheld.remains).toContain("never invents one");
    expect(withheld.remains).not.toContain("first build spent one");
  });

  it("says what was left before the call, what the first build leaves, and warns when that is low", () => {
    const before = readBuildAllowance(plan(342, 350))!;
    const spent = firstBuildSpendNarration({ what: "x", dispatched: true, before });

    expect(spent.remains).toBe("Before this call the workspace had 8 of 350 builds left this month; the first build spends one, leaving 7.");
    expect(spent.remaining).toBe(7);
    expect(spent.warning).toBe("7 builds remain of 350 this month; each project creation and each push spends one.");

    const withheld = firstBuildSpendNarration({ what: "x", dispatched: false, before });

    expect(withheld.remains).toBe("Before this call the workspace had 8 of 350 builds left this month, and no first build spent one.");
    expect(withheld.remaining).toBe(8);
  });

  it("carries no warning while the count stays above the threshold, and never goes below zero", () => {
    const fine = firstBuildSpendNarration({ what: "x", dispatched: true, before: readBuildAllowance(plan(4, 350))! });

    expect(fine.remaining).toBe(345);
    expect(fine.warning).toBeUndefined();

    const edge = firstBuildSpendNarration({ what: "x", dispatched: true, before: readBuildAllowance(plan(340, 350))! });

    expect(edge.remaining).toBe(9);
    expect(edge.warning).toContain("9 builds remain");

    expect(firstBuildSpendNarration({ what: "x", dispatched: true, before: readBuildAllowance(plan(350, 350))! }).remaining).toBe(0);
  });
});
