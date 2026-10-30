// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import {
  newestStoreReleaseByLane,
  newestStoreReleaseByStore,
  storeReleaseSentence,
  storeReleaseView,
  storeReleasesSentence,
  type StoreReleaseView,
} from "../lib/platform-store-releases";

const SHA: Record<string, string> = {
  "0.2.0.2": "21abf99",
  "0.2.0.6": "e4b8976",
  "0.2.0.7": "6d9e10c",
  "0.2.0.8": "e679664",
  "0.2.0.9": "a4c0e00",
};

function edge(version: string, state: string, submittedAt: string, updatedAt = submittedAt): StoreReleaseView {
  return storeReleaseView({
    id: `edge:${version}`,
    store: "edge",
    version,
    buildSha: SHA[version],
    state,
    storeWord: state === "live" ? "PUBLISHED" : state === "superseded" ? "" : "InProgress",
    readAt: updatedAt,
    source: state === "superseded" ? "inferred" : "poll",
    submissionId: `sub_${version}`,
    submittedAt,
    updatedAt,
  })!;
}

const REBECCAT = [
  edge("0.2.0.2", "superseded", "2026-10-24T10:00:00.000Z", "2026-10-30T16:00:00.000Z"),
  edge("0.2.0.6", "superseded", "2026-10-27T08:00:00.000Z", "2026-10-30T15:00:00.000Z"),
  edge("0.2.0.7", "live", "2026-10-27T22:00:00.000Z"),
  edge("0.2.0.8", "uploaded", "2026-10-29T19:00:00.000Z"),
  edge("0.2.0.9", "uploaded", "2026-10-30T01:00:00.000Z"),
];

describe("a store's release row is the newest version the project sent", () => {
  it("picks the newest version whatever order the platform listed the rows in, never a retired one touched last", () => {
    const byStore = newestStoreReleaseByStore(REBECCAT);

    expect(byStore.edge).toMatchObject({ id: "edge:0.2.0.9", state: "uploaded", buildSha: "a4c0e00" });
    expect(newestStoreReleaseByLane([...REBECCAT].reverse()).edge).toBe(byStore.edge);
    expect(storeReleaseSentence(byStore.edge)).toContain("edge 0.2.0.9 uploaded on build a4c0e00");
  });

  it("leads the history sentence with the live version and the newest upload, not the retired versions", () => {
    const said = storeReleasesSentence(REBECCAT, false);

    expect(said).toContain("Live in one store: edge 0.2.0.7 live");
    expect(said).toContain("Not live yet: edge 0.2.0.9 uploaded on build a4c0e00");
    expect(said).not.toContain("0.2.0.2");
  });

  it("falls back to the newest submission when the versions do not compare as numbers", () => {
    const older = { ...edge("0.2.0.7", "live", "2026-10-27T22:00:00.000Z"), version: "two" };
    const newer = { ...edge("0.2.0.9", "uploaded", "2026-10-30T01:00:00.000Z"), version: "nine" };

    expect(newestStoreReleaseByStore([older, newer]).edge).toBe(newer);
    expect(newestStoreReleaseByStore([newer, older]).edge).toBe(newer);
  });
});
