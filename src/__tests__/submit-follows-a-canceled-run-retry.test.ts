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
const MIRROR = /extension-user-land|actions\/runs|github\.com\/|\bmirror\b/i;
const SENTENCE = "GitHub canceled the run before upload; the platform started it again.";
const ARGS = {
  action: "submit",
  browsers: ["edge"],
  buildSha: "f29f204",
  dryRun: false,
  approvalId: "apr_edge",
  api: WORLD_API,
};

const ORIGINAL = {
  id: "sub_edge",
  store: "edge",
  status: "failed",
  rawStatus: "run cancelled",
  stage: "before-store",
  retriedAs: "sub_edge_retry",
  failureReason:
    "The edge run was cancelled before any store step ran, so no store received this submission; the platform dispatched it once more.",
  message: SENTENCE,
};

function approvedEdgeSubmit(world: World, reads: Array<Record<string, unknown>>): void {
  world.routes.push([
    /^GET \/api\/cli\/approvals\/apr_edge$/,
    () => ({
      body: {
        status: "approved",
        used: false,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        fingerprint: actionFingerprint("extension_submit", {
          browsers: ["edge"],
          buildSha: "f29f204",
          channel: "stable",
        }),
      },
    }),
  ]);

  world.routes.push([
    SUBMIT,
    () => ({
      body: {
        ok: true,
        buildId: "f29f204",
        channel: "stable",
        dispatchedAt: "2026-10-25T22:30:00.000Z",
        submissions: [{ id: "sub_edge", store: "edge", status: "pending" }],
      },
    }),
  ]);

  let read = 0;

  world.routes.push([
    RECORDS,
    () => {
      const row = reads[Math.min(read, reads.length - 1)];
      read += 1;

      return { body: { submissions: [row] } };
    },
  ]);
}

describe("a submit whose run GitHub canceled before upload follows the platform's one retry", () => {
  const world = usePlatformWorld("extdev-edge-retry-");

  it("says the platform started it again, tracks the retry, and never answers submit-failed", async () => {
    if (process.platform === "win32") return;

    world.login();
    approvedEdgeSubmit(world, [ORIGINAL]);

    const out = await world.call("extension_submit", { ...ARGS, waitSeconds: 0 });
    const context = JSON.stringify(out).slice(0, 2000);

    expect(out.status, context).toBe("submit-dispatched");
    expect(out.value.outcome.recorded).toBe(false);
    expect(out.value.retried).toEqual([
      expect.objectContaining({ store: "edge", retryOf: "sub_edge", submissionId: "sub_edge_retry" }),
    ]);

    expect(out.value.trackUrl).toMatch(/\/acme\/widget\/submissions\/edge\/sub_edge_retry$/);
    expect(out.value.nextStep.say).toContain(`edge: ${SENTENCE}`);
    expect(out.value.sayToPerson).toBe(out.value.nextStep.say);
    expect(out.hint).toContain(SENTENCE);
    expect(out.hint.split(SENTENCE)).toHaveLength(2);
    expect(out.status).not.toBe("submit-failed");
    expect(JSON.stringify(out)).not.toMatch(/fix the cause and submit again|did not reach/i);
    expect(JSON.stringify(out)).not.toMatch(MIRROR);
  });

  it("answers the retry's own record once it lands", async () => {
    if (process.platform === "win32") return;

    world.login();
    approvedEdgeSubmit(world, [
      ORIGINAL,
      { id: "sub_edge_retry", store: "edge", status: "draft", retryOf: "sub_edge" },
    ]);

    const out = await world.call("extension_submit", { ...ARGS, waitSeconds: 30 });
    const context = JSON.stringify(out).slice(0, 2000);

    expect(out.status, context).toBe("submitted");
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "draft" });
    expect(out.value.retried[0]).toMatchObject({ retryOf: "sub_edge", submissionId: "sub_edge_retry" });
    expect(out.value.trackUrl).toMatch(/\/submissions\/edge\/sub_edge_retry$/);
    expect(out.hint).toContain(SENTENCE);
    expect(JSON.stringify(out)).not.toMatch(MIRROR);
  });

  it("answers submit-failed when the retry is canceled too, since a retry is never retried", async () => {
    if (process.platform === "win32") return;

    world.login();
    approvedEdgeSubmit(world, [
      ORIGINAL,
      {
        id: "sub_edge_retry",
        store: "edge",
        status: "failed",
        retryOf: "sub_edge",
        stage: "before-store",
        failureReason:
          "The edge run was cancelled before any store step ran, so no store received this submission, and it was already the platform's one retry. Submit edge again; nothing reached the store.",
      },
    ]);

    const out = await world.call("extension_submit", { ...ARGS, waitSeconds: 30 });
    const context = JSON.stringify(out).slice(0, 2000);

    expect(out.status, context).toBe("submit-failed");
    expect(out.error.message).toContain("already the platform's one retry");
    expect(out.value.retried[0]).toMatchObject({ submissionId: "sub_edge_retry" });
    expect(JSON.stringify(out)).not.toMatch(MIRROR);
  });

  it("names the retry in the release status read while the retry is pending", async () => {
    if (process.platform === "win32") return;

    world.login();
    world.routes.push([
      RECORDS,
      () => ({
        body: {
          submissions: [
            {
              id: "sub_edge_retry",
              store: "edge",
              status: "pending",
              retryOf: "sub_edge",
              submittedAt: "2026-10-25T22:40:00.000Z",
              outcome: "running",
              message: "The edge submission run is queued; read again once it completes.",
            },
          ],
        },
      }),
    ]);

    const out = await world.call("extension_release_status", { include: ["stores"], api: WORLD_API });
    const context = JSON.stringify(out).slice(0, 3000);
    const section = out.value.stores;
    const edge = section.value.stores.find((row: { store: string }) => row.store === "edge");

    expect(edge?.lastSubmission, context).toMatchObject({ id: "sub_edge_retry", retryOf: "sub_edge" });
    expect(section.hint).toContain(`last submission pending at 2026-10-25T22:40:00.000Z`);
    expect(section.hint).toContain(SENTENCE.replace(/\.$/, ""));
    expect(out.value.trackUrl).toMatch(/^https?:\/\//);
    expect(JSON.stringify(out)).not.toMatch(MIRROR);
  });
});
