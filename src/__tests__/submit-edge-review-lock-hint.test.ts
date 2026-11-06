// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { lockSentences } from "../tools/store-acts";
import { schema } from "../tools/submit";

const LOCKED = {
  edge: {
    act: "publish",
    lock: { kind: "review", clearsWhen: "Edge finishes certification", storeWord: "InProgressSubmission", source: "store" },
  },
};

describe("extension_submit tells the agent what Edge does while a submission is in certification review", () => {
  it("says in the answer that a locked publish is queued, never failed, and never cancels the review", () => {
    const said = lockSentences(LOCKED);

    expect(said).toContain("edge: the publish is locked until Edge finishes certification (InProgressSubmission)");
    expect(said).toMatch(/queued behind it, never failed/);
    expect(said).toMatch(/never cancels that review/);
  });

  it("says an Edge upload during a review replaces the draft package only, and names Edge in the description", () => {
    expect(lockSentences(LOCKED)).toMatch(/upload meanwhile replaces the draft package only/);
    expect(String(schema.description)).toContain("Edge");
  });
});
