// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { APPROVAL_REFUND_SENTENCE } from "../lib/approval-refund-words";
import { toSubmission } from "../lib/platform-submissions";
import { latestSubmissionsByStore } from "../tools/store-status";
import { WORLD_API, usePlatformWorld, type World } from "./fixtures/platform-world";

const SUBMIT = /^POST \/api\/cli\/stores\/submit$/;
const RECORDS = /^GET \/api\/cli\/stores\/submissions$/;
const MIRROR = /extension-user-land|actions\/runs|github\.com\/|\bmirror\b/i;
const REASON =
  "GitHub ended the run before any step of it started, so nothing ran and the approval it spent was given back";

const REFUNDED = {
  id: "sub_safari",
  store: "safari",
  status: "failed",
  buildId: "f29f204",
  version: "0.3.0",
  submittedAt: "2026-11-01T20:10:00.000Z",
  failureReason: "The safari run was canceled before any step ran, so no store received this submission.",
  approvalRefunded: true,
  approvalRefundReason: REASON,
};

const UNREFUNDED = {
  id: "sub_edge",
  store: "edge",
  status: "failed",
  buildId: "f29f204",
  version: "0.3.0",
  submittedAt: "2026-11-01T20:10:00.000Z",
  failureReason: "Partner Center refused the package.",
};

function serveRecords(world: World, rows: unknown[]): void {
  world.routes.push([RECORDS, () => ({ body: { submissions: rows } })]);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("a store run GitHub ended before any step names the approval the platform gave back", () => {
  const world = usePlatformWorld("extdev-approval-refund-");

  it("keeps the refund and its reason on the platform submission, and nothing on an unrefunded row", () => {
    expect(toSubmission(REFUNDED)).toMatchObject({ approvalRefunded: true, approvalRefundReason: REASON });

    const plain = toSubmission(UNREFUNDED);
    expect(plain).not.toHaveProperty("approvalRefunded");
    expect(plain).not.toHaveProperty("approvalRefundReason");
    expect(toSubmission({ ...UNREFUNDED, approvalRefunded: "yes" })).not.toHaveProperty("approvalRefunded");

    const views = latestSubmissionsByStore({ submissions: [REFUNDED, UNREFUNDED] });
    expect(views.safari).toMatchObject({ approvalRefunded: true, approvalRefundReason: REASON });
    expect(views.edge).not.toHaveProperty("approvalRefunded");
  });

  it("says the refund once in extension_release_status, on the refunded store only", async () => {
    if (process.platform === "win32") return;

    world.login();
    serveRecords(world, [REFUNDED, UNREFUNDED]);

    const out = await world.call("extension_release_status", { include: ["stores"], api: WORLD_API });
    const section = out.value.stores;
    const rows: Array<{ store: string; lastSubmission?: Record<string, unknown> }> = section.value.stores;
    const safari = rows.find((row) => row.store === "safari");
    const edge = rows.find((row) => row.store === "edge");
    const context = JSON.stringify(section).slice(0, 3000);

    expect(safari?.lastSubmission, context).toMatchObject({ approvalRefunded: true, approvalRefundReason: REASON });
    expect(edge?.lastSubmission, context).toMatchObject({ id: "sub_edge", status: "failed" });
    expect(edge?.lastSubmission).not.toHaveProperty("approvalRefunded");
    expect(count(section.hint, APPROVAL_REFUND_SENTENCE)).toBe(1);

    const hint = String(section.hint);
    const edgeLine = hint.slice(hint.indexOf("edge:"), hint.indexOf("safari:"));
    const safariLine = hint.slice(hint.indexOf("safari:"));
    expect(edgeLine).toContain("Partner Center refused the package");
    expect(edgeLine).not.toContain(APPROVAL_REFUND_SENTENCE);
    expect(safariLine).toContain(`no store received this submission.); ${APPROVAL_REFUND_SENTENCE}.`);
    expect(JSON.stringify(out)).not.toMatch(MIRROR);
  });

  it("answers the refund on extension_submit status rows and says it once", async () => {
    if (process.platform === "win32") return;

    world.login();
    serveRecords(world, [REFUNDED, UNREFUNDED]);

    const out = await world.call("extension_submit", { action: "status", browsers: ["safari", "edge"], api: WORLD_API });
    const context = JSON.stringify(out).slice(0, 3000);
    const [safari, edge] = out.value.stores;

    expect(out.status, context).toBe("status-read");
    expect(safari).toMatchObject({ store: "safari", status: "failed", approvalRefunded: true, approvalRefundReason: REASON });
    expect(edge).toMatchObject({ store: "edge", status: "failed" });
    expect(edge).not.toHaveProperty("approvalRefunded");
    expect(count(out.hint, APPROVAL_REFUND_SENTENCE)).toBe(1);
    expect(out.hint).toMatch(new RegExp(`^safari 0\\.3\\.0: failed[^.]*; ${APPROVAL_REFUND_SENTENCE.slice(0, 40)}`));
    expect(JSON.stringify(out)).not.toMatch(MIRROR);
  });

  it("names the given back approval in the failed submit sentence for the refunded store only", async () => {
    if (process.platform === "win32") return;

    world.login();
    world.routes.push([
      /^GET \/api\/cli\/approvals\/apr_two$/,
      () => ({
        body: {
          status: "approved",
          used: false,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          fingerprint: actionFingerprint("extension_submit.version", {
            acts: ["edge:upload", "safari:upload"],
            buildSha: "f29f204",
            version: "",
          }),
          lines: ["edge", "safari"].map((store) => ({
            id: `${store}:upload`,
            store,
            act: "upload",
            state: "approved",
            line: `Upload build f29f204 to ${store} as a draft.`,
          })),
        },
      }),
    ]);

    world.routes.push([
      SUBMIT,
      () => ({
        body: {
          ok: true,
          buildId: "f29f204",
          dispatchedAt: "2026-11-01T20:09:00.000Z",
          submissions: [
            { id: "sub_edge", store: "edge", status: "pending" },
            { id: "sub_safari", store: "safari", status: "pending" },
          ],
        },
      }),
    ]);

    serveRecords(world, [UNREFUNDED, REFUNDED]);

    const out = await world.call("extension_submit", {
      action: "submit",
      browsers: ["edge", "safari"],
      buildSha: "f29f204",
      dryRun: false,
      approvalId: "apr_two",
      waitSeconds: 30,
      api: WORLD_API,
    });
    const context = JSON.stringify(out).slice(0, 3000);

    expect(out.status, context).toBe("submit-failed");
    expect(out.value.outcomes.safari).toMatchObject({ status: "failed", approvalRefunded: true, approvalRefundReason: REASON });
    expect(out.value.outcomes.edge).not.toHaveProperty("approvalRefunded");
    expect(out.value.nextStep.say).toContain(`safari: ${APPROVAL_REFUND_SENTENCE}.`);
    expect(out.value.nextStep.say).not.toContain(`edge: ${APPROVAL_REFUND_SENTENCE}`);
    expect(count(out.value.sayToPerson, APPROVAL_REFUND_SENTENCE)).toBe(1);
    expect(JSON.stringify(out)).not.toMatch(MIRROR);
  });
});
