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

  it("dates a read older than an hour with the call that reads it again, and names the act that records a cancel made in Partner Center on the submission in flight (ledgers 570 and 677)", () => {
    const READ_AT = "2026-11-10T18:00:00.000Z";
    const now = Date.parse("2026-11-12T22:46:00.000Z");
    const stale = lockSentences({ edge: { ...LOCKED.edge, lock: { ...LOCKED.edge.lock, readAt: READ_AT } } }, now);
    const fresh = lockSentences({ edge: { ...LOCKED.edge, lock: { ...LOCKED.edge.lock, readAt: "2026-11-12T22:45:00.000Z" } } }, now);

    expect(stale).toContain(`Partner Center answered this 52 hours ago (${READ_AT}); extension_submit_check {action: "submit", browsers: ["edge"]} reads it fresh.`);
    expect(fresh).not.toContain("answered this");
    expect(fresh).toContain(
      'If that review was canceled in Partner Center, extension_submit {action: "cancel", store: "edge"} records it under a workspace owner\'s approval and clears this lock at once; it records the person\'s word and sends nothing to Partner Center.',
    );

    expect(lockSentences({ edge: { ...LOCKED.edge, inFlight: { submissionId: "sub_e1", version: "0.3.1.13" } } }, now)).toContain(
      'extension_submit {action: "cancel", store: "edge", submissionId: "sub_e1"}',
    );
  });

  it("says an Edge upload during a review replaces the draft package only, and names Edge in the description", () => {
    expect(lockSentences(LOCKED)).toMatch(/upload meanwhile replaces the draft package only/);
    expect(String(schema.description)).toContain("Edge");
  });
});
