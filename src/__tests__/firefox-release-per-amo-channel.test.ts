// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { storeReleaseView, storeReleasesSentence } from "../lib/platform-store-releases";
import { firefoxReleasesByChannel } from "../tools/store-status";

const SIGNED = storeReleaseView({
  id: "firefox:0.2.0.8",
  store: "firefox",
  version: "0.2.0.8",
  buildSha: "069d4b8",
  state: "live",
  storeWord: "PUBLIC",
  readAt: "2026-10-29T12:00:00.000Z",
  source: "poll",
  visibility: "unlisted",
  amoChannel: "unlisted",
  submissionId: "sub_8",
  submittedAt: "2026-10-29T11:00:00.000Z",
  updatedAt: "2026-10-29T12:00:00.000Z",
})!;

const LISTED = storeReleaseView({
  id: "firefox:0.2.0.7",
  store: "firefox",
  version: "0.2.0.7",
  buildSha: "069d4b8",
  state: "in-review",
  storeWord: "UNREVIEWED",
  readAt: "2026-10-28T12:00:00.000Z",
  source: "poll",
  amoChannel: "listed",
  submissionId: "sub_7",
  submittedAt: "2026-10-28T11:00:00.000Z",
  updatedAt: "2026-10-28T12:00:00.000Z",
})!;

describe("the Firefox store read answers one line per AMO channel", () => {
  it("keeps the listed version in review beside the unlisted version signed after it", () => {
    expect(firefoxReleasesByChannel([SIGNED, LISTED])).toEqual({ unlisted: SIGNED, listed: LISTED });

    const said = storeReleasesSentence([SIGNED, LISTED], false);

    expect(said).toContain("firefox unlisted 0.2.0.8 live, unlisted on build 069d4b8");
    expect(said).toContain("firefox listed 0.2.0.7 in-review on build 069d4b8");
  });

  it("answers no channel lines for a Firefox row the platform did not key on a channel", () => {
    const { amoChannel: _none, ...plain } = SIGNED;

    expect(firefoxReleasesByChannel([plain])).toBeNull();
    expect(storeReleasesSentence([plain], false)).toContain("firefox 0.2.0.8 live");
  });
});
