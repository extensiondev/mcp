// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { storeReleaseSentence, storeReleasesSentence, storeReleaseView } from "../lib/platform-store-releases";

const FAILED_ROW = {
  id: "firefox:0.2.0.4",
  store: "firefox",
  version: "0.2.0.4",
  buildSha: "2bda5b2",
  state: "failed",
  storeWord: "FAILED",
  readAt: "2026-11-04T20:40:00.000Z",
  source: "run",
  submissionId: "amo:rebeccat:2bda5b2:0.2.0.4",
  submittedAt: "2026-11-04T20:30:00.000Z",
  updatedAt: "2026-11-04T20:40:00.000Z",
  amoChannel: "listed",
};

describe("an upload the store refused reads failed, as the platform labels it", () => {
  it("keeps the platform's failed state instead of reading it as a state this MCP does not know", () => {
    const row = storeReleaseView(FAILED_ROW);

    expect(row).toMatchObject({ state: "failed" });
    expect(row).not.toHaveProperty("stateWord");
  });

  it("says upload failed in the sentence and never live, rejected or unknown", () => {
    const row = storeReleaseView(FAILED_ROW)!;
    const sentence = storeReleaseSentence(row);

    expect(sentence).toContain("0.2.0.4 upload failed (the store did not take the package) on build 2bda5b2");
    expect(sentence).not.toMatch(/unknown|rejected/);
    expect(storeReleasesSentence([row], false)).toContain("Nothing is live in a store.");
  });
});
