import { describe, expect, it } from "vitest";

import { toSubmission } from "../lib/platform-submissions";
import { STORE_READS_MAX, storeReadOf, storeReadsOf } from "../lib/store-reads";

const approved = { word: "approved", readAt: "2026-10-30T18:00:00.000Z", source: "poll", state: "PENDING_DEVELOPER_RELEASE" };
const withdrawn = { word: "withdrawn", readAt: "2026-11-01T09:00:00.000Z", source: "poll", state: "DEVELOPER_REJECTED", liveState: "READY_FOR_SALE" };

describe("the platform's store reads are carried as stored", () => {
  it("keeps every placed read in order, oldest first and newest last", () => {
    expect(storeReadsOf([approved, withdrawn])).toEqual([approved, withdrawn]);
  });

  it("answers nothing for a record without reads and drops a read it cannot place", () => {
    expect(storeReadsOf(undefined)).toBeUndefined();
    expect(storeReadsOf([])).toBeUndefined();
    expect(storeReadOf("approved")).toBeUndefined();
    expect(storeReadOf({ ...approved, word: "" })).toBeUndefined();
    expect(storeReadOf({ ...approved, readAt: "not a date" })).toBeUndefined();
    expect(storeReadOf({ ...approved, state: undefined })).toBeUndefined();
    expect(storeReadOf({ ...approved, source: undefined })).toBeUndefined();
    expect(storeReadsOf([approved, { word: "" }, "withdrawn", withdrawn])).toEqual([approved, withdrawn]);
  });

  it("lowercases the word and keeps the store's own detail fields", () => {
    expect(storeReadOf({ ...withdrawn, word: "Withdrawn", crxVersion: "1.0.0.3", visibility: "unlisted" })).toEqual({
      ...withdrawn,
      crxVersion: "1.0.0.3",
      visibility: "unlisted",
    });
  });

  it("answers at most fifty reads, the first and the newest forty-nine", () => {
    const reads = storeReadsOf(
      Array.from({ length: 60 }, (_unused, index) => ({
        word: `word-${index}`,
        readAt: new Date(Date.UTC(2026, 9, 1, index)).toISOString(),
        source: "poll",
        state: `STATE_${index}`,
      })),
    );

    expect(STORE_READS_MAX).toBe(50);
    expect(reads).toHaveLength(50);
    expect(reads?.[0]?.word).toBe("word-0");
    expect(reads?.[1]?.word).toBe("word-11");
    expect(reads?.[49]?.word).toBe("word-59");
  });

  it("rides the platform submission row and stays off a row without them", () => {
    expect(toSubmission({ store: "safari", status: "withdrawn", storeReads: [approved, withdrawn] })?.storeReads).toEqual([approved, withdrawn]);
    expect("storeReads" in (toSubmission({ store: "safari", status: "withdrawn" }) ?? {})).toBe(false);
  });
});
