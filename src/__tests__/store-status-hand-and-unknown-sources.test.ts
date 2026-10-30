import { describe, expect, it } from "vitest";

import { storeReleaseSentence, storeReleasesOf, storeReleasesSentence, storeReleaseView } from "../lib/platform-store-releases";
import { statusReadOf } from "../lib/platform-submissions";
import { safariReleaseStepSentence, statusReadNote } from "../tools/store-status";

const RECORDED_AT = "2026-10-30T14:10:00.000Z";
const NOTE = "AMO developer hub: disabled when 0.2.0.7 was uploaded, no reviewer action";

const HAND_ROW = {
  id: "firefox:0.2.0.5",
  store: "firefox",
  version: "0.2.0.5",
  buildSha: "069d4b8",
  state: "superseded",
  storeWord: "superseded",
  readAt: RECORDED_AT,
  source: "hand",
  submissionId: "5a1b2c3d",
  submittedAt: "2026-10-25T10:00:00.000Z",
  updatedAt: RECORDED_AT,
  amoChannel: "listed",
};

describe("a status word the owner recorded by hand keeps its provenance", () => {
  it("reads a hand source with the owner's line, and says no store check read it", () => {
    const read = statusReadOf({ word: "superseded", readAt: RECORDED_AT, source: "hand", note: NOTE });

    expect(read).toEqual({ word: "superseded", readAt: RECORDED_AT, source: "hand", note: NOTE });
    expect(statusReadNote(read)).toBe(
      ` (recorded by hand from the store's own dashboard at ${RECORDED_AT}, not read by a store check: ${NOTE})`,
    );
  });

  it("answers a hand store release row as recorded by hand, never as a store's word read by a poll", () => {
    const row = storeReleaseView(HAND_ROW);

    expect(row).toMatchObject({ state: "superseded", source: "hand" });
    expect(storeReleaseSentence(row!)).toBe(
      `firefox listed 0.2.0.5 superseded on build 069d4b8 (recorded by hand from the store's own dashboard ${RECORDED_AT}, not read by a store check)`,
    );
  });
});

describe("a source or state this server does not know is relayed, never dropped", () => {
  it("keeps a status read whose source is newer than this server and grounds no step on it", () => {
    const read = statusReadOf({ word: "approved", readAt: RECORDED_AT, source: "store-webhook", storeWord: "PENDING_DEVELOPER_RELEASE" });

    expect(read).toEqual({
      word: "approved",
      readAt: RECORDED_AT,
      source: "unknown",
      sourceWord: "store-webhook",
      storeWord: "PENDING_DEVELOPER_RELEASE",
    });

    expect(statusReadNote(read)).toBe(
      ` (read by a source this MCP does not know (store-webhook) at ${RECORDED_AT}, so it grounds no next step; update the MCP to read it)`,
    );

    expect(
      safariReleaseStepSentence({ store: "safari", version: "0.2.0", status: "approved", statusRead: read } as never),
    ).toBe("");
  });

  it("keeps a store release row whose state is newer than this server, and never counts it live", () => {
    const { rows } = storeReleasesOf({
      storeReleases: [
        { ...HAND_ROW, id: "chrome:0.3.0", store: "chrome", version: "0.3.0", state: "staged-rollout", storeWord: "STAGED", source: "poll", amoChannel: undefined },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "unknown", stateWord: "staged-rollout" });
    expect(storeReleaseSentence(rows[0]!)).toContain("0.3.0 staged-rollout (a state this MCP does not know; update the MCP to read it)");

    const sentence = storeReleasesSentence(rows, false);

    expect(sentence).toContain("Nothing is live in a store.");
    expect(sentence).not.toContain("Live in");
  });

  it("names a row source this server does not know as such", () => {
    const row = storeReleaseView({ ...HAND_ROW, source: "store-webhook", storeWord: "PUBLIC" });

    expect(storeReleaseSentence(row!)).toContain(
      `the store's word PUBLIC, read ${RECORDED_AT} by store-webhook, a source this MCP does not know, so it grounds no next step`,
    );
  });
});
