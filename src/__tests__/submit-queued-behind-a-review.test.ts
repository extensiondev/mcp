// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { WORLD_API, usePlatformWorld, type World } from "./fixtures/platform-world";

const SUBMIT = /^POST \/api\/cli\/stores\/submit$/;
const RECORDS = /^GET \/api\/cli\/stores\/submissions$/;
const MIRROR = /extension-user-land|actions\/runs|github\.com\//;
const CHECKED_AT = "2026-10-28T14:05:00.000Z";

const queuedSafari = {
  id: "qact_1",
  act: "submit",
  store: "safari",
  buildSha: "f29f204",
  status: "queued",
  lock: {
    kind: "review-in-progress",
    storeWord: "WAITING_FOR_REVIEW",
    clearsWhen: "Apple finishes reviewing 0.2.0 (build 11)",
    readAt: "2026-10-28T13:40:00.000Z",
  },
  queuedAt: "2026-10-28T14:00:00.000Z",
  lastCheckedAt: CHECKED_AT,
  message: `Queued behind WAITING_FOR_REVIEW, sends when it clears. Checked ${CHECKED_AT}.`,
};

function approved(world: World, browsers: string[], approvalId: string): void {
  world.routes.push([
    new RegExp(`^GET /api/cli/approvals/${approvalId}$`),
    () => ({
      body: {
        status: "approved",
        used: false,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        fingerprint: actionFingerprint("extension_submit", { browsers, buildSha: "f29f204" }),
      },
    }),
  ]);
}

describe("a submit the store's review of another version holds back is queued, not failed", () => {
  const world = usePlatformWorld("extdev-submit-queued-");

  it("answers submit-queued with the store's word, when it was checked and the clearsWhen sentence, and waits on no record", async () => {
    if (process.platform === "win32") return;

    world.login();
    approved(world, ["safari"], "apr_safari");
    world.routes.push([
      SUBMIT,
      () => ({
        body: {
          ok: true,
          buildId: "f29f204",
          status: "submit-queued",
          submissions: [{ store: "safari", status: "queued", queued: queuedSafari, message: queuedSafari.message }],
          queued: [queuedSafari],
        },
      }),
    ]);

    world.routes.push([RECORDS, () => ({ body: { submissions: [], queued: [queuedSafari] } })]);

    const out = await world.call("extension_submit", {
      action: "submit",
      browsers: ["safari"],
      buildSha: "f29f204",
      dryRun: false,
      approvalId: "apr_safari",
      api: WORLD_API,
      waitSeconds: 5,
    });
    const context = JSON.stringify(out).slice(0, 2000);

    expect(out.ok, context).toBe(true);
    expect(out.status, context).toBe("submit-queued");
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "queued", storeState: "WAITING_FOR_REVIEW" });
    expect(out.value.queued).toEqual([expect.objectContaining({ store: "safari", storeWord: "WAITING_FOR_REVIEW", lastCheckedAt: CHECKED_AT })]);
    expect(out.value.submittedStores).toEqual([]);
    expect(out.value.nextStep.kind).toBe("watch");
    expect(out.hint).toContain(`safari: Queued behind WAITING_FOR_REVIEW, sends when it clears (checked ${CHECKED_AT}); it sends on its own once Apple finishes reviewing 0.2.0 (build 11)`);
    expect(out.hint).toContain("nothing needs to be submitted again");
    expect(world.calls.filter((call) => RECORDS.test(`${call.method} ${call.path}`))).toHaveLength(0);
    expect(JSON.stringify(out)).not.toMatch(MIRROR);
  });

  it("waits on the stores that were sent and says the queued one beside them", async () => {
    if (process.platform === "win32") return;

    world.login();
    approved(world, ["edge", "safari"], "apr_both");
    world.routes.push([
      SUBMIT,
      () => ({
        body: {
          ok: true,
          buildId: "f29f204",
          dispatchedAt: "2026-10-28T14:05:10.000Z",
          submissions: [
            { id: "sub_edge", store: "edge", status: "pending" },
            { store: "safari", status: "queued", queued: queuedSafari, message: queuedSafari.message },
          ],
          queued: [queuedSafari],
        },
      }),
    ]);

    world.routes.push([
      RECORDS,
      () => ({ body: { submissions: [{ id: "sub_edge", store: "edge", status: "uploaded", storeUpload: { state: "SUCCEEDED", checkedAt: CHECKED_AT } }], queued: [queuedSafari] } }),
    ]);

    const out = await world.call("extension_submit", {
      action: "submit",
      browsers: ["edge", "safari"],
      buildSha: "f29f204",
      dryRun: false,
      approvalId: "apr_both",
      api: WORLD_API,
      waitSeconds: 5,
    });
    const context = JSON.stringify(out).slice(0, 2000);

    expect(out.status, context).toBe("submitted");
    expect(out.value.submittedStores).toEqual(["edge"]);
    expect(out.value.queuedStores).toEqual(["safari"]);
    expect(out.value.outcome.recorded).toBe(true);
    expect(out.hint).toContain("safari: Queued behind WAITING_FOR_REVIEW, sends when it clears");
    expect(JSON.stringify(out)).not.toMatch(MIRROR);
  });
});
