import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FREE_ALLOWANCE_PHRASE,
  allowanceWallUrl,
  readPlatformAllowance,
  spendNarration,
} from "../lib/allowance";

const DATE_TOKEN =
  /\b20\d{2}\b|January|February|March|April|June|July|August|September|October|November|December|\bMay\b/;

describe("the free allowance narration", () => {
  let prevApi: string | undefined;

  beforeEach(() => {
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
  });

  afterEach(() => {
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;
  });

  it("keeps the one house phrasing, verbatim", () => {
    expect(FREE_ALLOWANCE_PHRASE).toBe("counts against your free allowance");
  });

  it("says what was spent using the house phrasing and our machines", () => {
    const n = spendNarration({ what: "This share upload" });
    expect(n.spent).toBe(
      "This share upload ran on extension.dev's machines and counts against your free allowance.",
    );
  });

  it("invents no remaining count when the platform sent none", () => {
    const n = spendNarration({ what: "This publish", body: { shareUrl: "x" } });
    expect(n.remains).not.toMatch(/\d/);
    expect(n.remains).toContain("never invents one");
    expect(n.remains).toContain("refuses with its own numbers");
  });

  it("relays the platform's own count when a response carries one", () => {
    const n = spendNarration({
      what: "This promote",
      body: { allowance: { used: 7, limit: 100 } },
    });
    expect(n.remains).toBe("The platform reports 7 of 100 used.");
  });

  it("reads a quota record the same way", () => {
    expect(readPlatformAllowance({ quota: { used: 3, limit: 25 } })).toEqual({
      used: 3,
      limit: 25,
    });
  });

  it("refuses partial or malformed platform numbers rather than guessing", () => {
    expect(readPlatformAllowance({ allowance: { used: 7 } })).toBeNull();
    expect(
      readPlatformAllowance({ allowance: { used: "7", limit: "100" } }),
    ).toBeNull();
    expect(
      readPlatformAllowance({ allowance: { used: -1, limit: 100 } }),
    ).toBeNull();
    expect(readPlatformAllowance({ allowance: [7, 100] })).toBeNull();
    expect(readPlatformAllowance(null)).toBeNull();
    expect(readPlatformAllowance("allowance")).toBeNull();
  });

  it("ships no calendar date of its own, with or without platform numbers", () => {
    for (const body of [undefined, { allowance: { used: 1, limit: 100 } }]) {
      const n = spendNarration({ what: "This submission", body });
      expect(n.spent).not.toMatch(DATE_TOKEN);
      expect(n.remains).not.toMatch(DATE_TOKEN);
      expect(n.wall).not.toMatch(DATE_TOKEN);
    }
  });

  it("points the wall at the platform's pricing page, which owns the dates", () => {
    expect(allowanceWallUrl()).toBe("https://www.extension.dev/pricing");
    expect(allowanceWallUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/pricing",
    );
    const n = spendNarration({ what: "This publish" });
    expect(n.wall).toBe(
      "What the free allowance covers and when the paid plan starts are published at https://www.extension.dev/pricing.",
    );
  });
});
