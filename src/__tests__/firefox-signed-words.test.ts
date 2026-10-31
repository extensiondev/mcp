// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { STORE_RELEASE_STATES, storeReleaseSentence, storeReleasesSentence, storeReleaseView } from "../lib/platform-store-releases";
import { statusReadNote } from "../tools/store-status";
import { storeVersionSentence } from "../tools/store-version-status";

const SIGNED = storeReleaseView({
  id: "firefox:0.1.0.2",
  store: "firefox",
  version: "0.1.0.2",
  buildSha: "4b5ae18",
  state: "signed",
  storeWord: "PUBLIC",
  readAt: "2026-10-31T11:35:00.000Z",
  source: "poll",
  visibility: "unlisted",
  amoChannel: "unlisted",
  submissionId: "sub_2",
  submittedAt: "2026-10-31T11:00:00.000Z",
  updatedAt: "2026-10-31T11:35:00.000Z",
})!;

describe("an unlisted Firefox version AMO signed reads signed, not on AMO, never live or public", () => {
  it("relays the platform's signed state by name and says it with the self-distribution clarification and AMO's own word", () => {
    expect(STORE_RELEASE_STATES).toContain("signed");
    expect(SIGNED.state).toBe("signed");
    expect(SIGNED.stateWord).toBeUndefined();

    const said = storeReleaseSentence(SIGNED);

    expect(said).toBe("firefox unlisted 0.1.0.2 signed (unlisted, not on AMO) on build 4b5ae18 (AMO's file status PUBLIC, read 2026-10-31T11:35:00.000Z by poll)");
    expect(said).not.toContain("live");
    expect(said).not.toContain("the store's word");
  });

  it("lists a signed version under its own clause and still says nothing is live in a store", () => {
    const said = storeReleasesSentence([SIGNED], false);

    expect(said).toContain("Signed for self distribution, not on AMO: firefox unlisted 0.1.0.2 signed (unlisted, not on AMO)");
    expect(said).toContain("Nothing is live in a store.");
    expect(said).not.toContain("Live in");
    expect(said).not.toContain("Not live yet");
  });

  it("names AMO's word as its file status beside a signed submission in the store read and the status act", () => {
    expect(statusReadNote({ word: "signed", source: "poll", readAt: "2026-10-31T11:35:00.000Z", storeWord: "PUBLIC" }, true)).toBe(
      " (read from a store check at 2026-10-31T11:35:00.000Z, AMO's file status PUBLIC)",
    );

    expect(statusReadNote({ word: "published", source: "poll", readAt: "2026-10-31T11:35:00.000Z", storeWord: "PUBLISHED" })).toContain("the store says PUBLISHED");

    const sentence = storeVersionSentence(
      { store: "firefox", submissionId: "sub_2", version: "0.1.0.2", buildNumber: null, status: "signed", state: "PUBLIC", readAt: "2026-10-31T11:35:00.000Z", source: "poll", releaseType: null, nextStep: null },
      null,
      null,
    );

    expect(sentence).toBe("firefox 0.1.0.2: signed (unlisted, not on AMO), AMO's file status PUBLIC (poll at 2026-10-31T11:35:00.000Z)");
    expect(sentence).not.toContain("the store says");
  });
});
