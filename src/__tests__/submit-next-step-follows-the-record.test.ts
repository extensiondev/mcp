// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { outcomeClock } from "../lib/act-outcome";
import { actionFingerprint } from "../lib/approval-gate";
import { PUBLISH_SENTENCE } from "../lib/store-connection";
import { WORLD_API, WORLD_PROJECT_ID, usePlatformWorld, type World } from "./fixtures/platform-world";

const SUBMIT = /^POST \/api\/cli\/stores\/submit$/;
const RECORDS = /^GET \/api\/cli\/stores\/submissions$/;
const MIRROR = /extension-user-land|actions\/runs|github\.com\//;
const ARGS = {
  action: "submit",
  browsers: ["edge"],
  buildSha: "f29f204",
  dryRun: false,
  approvalId: "apr_edge",
  api: WORLD_API,
};

function approvedEdgeSubmit(world: World, record: Record<string, unknown>): void {
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
        dispatchedAt: "2026-10-24T03:12:52.000Z",
        submissions: [{ id: "sub_edge", store: "edge", status: "pending" }],
      },
    }),
  ]);

  world.routes.push([RECORDS, () => ({ body: { submissions: [{ id: "sub_edge", store: "edge", ...record }] } })]);
}

const FIREFOX_ARGS = { ...ARGS, browsers: ["firefox"], approvalId: "apr_firefox" };
const AMO_WORDS =
  'FIREFOX_METADATA_REFUSED: AMO refused the listing metadata (HTTP 400 on categories, summary): categories: Invalid pk "productivity" - object does not exist.; summary (en-US): Ensure this field has no more than 250 characters.';

function approvedFirefoxSubmit(world: World, record: Record<string, unknown>): void {
  world.routes.push([
    /^GET \/api\/cli\/approvals\/apr_firefox$/,
    () => ({
      body: {
        status: "approved",
        used: false,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        fingerprint: actionFingerprint("extension_submit", {
          browsers: ["firefox"],
          buildSha: "f29f204",
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
        dispatchedAt: "2026-10-26T17:36:41.000Z",
        submissions: [{ id: "sub_firefox", store: "firefox", status: "pending" }],
      },
    }),
  ]);

  world.routes.push([RECORDS, () => ({ body: { submissions: [{ id: "sub_firefox", store: "firefox", ...record }] } })]);
}

describe("a failed Firefox listed upload answers AMO's own words", () => {
  const world = usePlatformWorld("extdev-firefox-record-");

  it("carries the metadata refusal word for word and never the done sentence", async () => {
    if (process.platform === "win32") return;

    world.login();
    approvedFirefoxSubmit(world, { status: "failed", rawStatus: "failed", failureReason: AMO_WORDS });

    const out = await world.call("extension_submit", { ...FIREFOX_ARGS, waitSeconds: 5 });
    const context = JSON.stringify(out).slice(0, 2000);

    expect(out.status, context).toBe("submit-failed");
    expect(out.value.outcome.recorded).toBe(true);
    expect(out.value.outcome.status).toBe("failed");
    expect(out.value.nextStep.kind).toBe("resubmit");
    expect(out.value.nextStep.say).toContain(`The store answered: firefox: ${AMO_WORDS.replace(/[.\s]+$/, "")}`);
    expect(out.value.nextStep.say).toContain("nothing is in review");
    expect(JSON.stringify(out.value.nextStep)).not.toMatch(/review comes after this|recorded the submission/);
    expect(JSON.stringify(out)).not.toMatch(MIRROR);
  });
});

describe("the Edge submit's next step follows outcome.recorded", () => {
  const world = usePlatformWorld("extdev-edge-record-");

  it("says dispatched and never uploaded and recorded while the record has not confirmed", async () => {
    if (process.platform === "win32") return;

    world.login();
    approvedEdgeSubmit(world, { status: "pending" });

    const out = await world.call("extension_submit", { ...ARGS, waitSeconds: 0 });
    const context = JSON.stringify(out).slice(0, 2000);

    expect(out.status, context).toBe("submit-dispatched");
    expect(out.value.outcome.recorded).toBe(false);
    expect(out.value.nextStep.kind).toBe("watch");
    expect(out.value.nextStep.say).toContain("dispatched; the record confirms when the run finishes");
    expect(out.value.sayToPerson).toBe(out.value.nextStep.say);
    expect(JSON.stringify(out.value.nextStep)).not.toMatch(/uploaded and recorded|recorded as uploaded/);
    expect(out.value.nextStep.url).toMatch(/\/acme\/widget\/submissions\/edge\/sub_edge$/);
    expect(out.value.trackUrl).toMatch(/^https?:\/\//);
    expect(JSON.stringify(out)).not.toMatch(MIRROR);
  });

  it("names the step that failed after the upload when the record reads uploaded with a failure", async () => {
    if (process.platform === "win32") return;

    world.login();
    approvedEdgeSubmit(world, {
      status: "uploaded",
      rawStatus: "uploaded",
      failure: {
        step: "Record the store submission",
        lastLines: ["ERROR registry-store-submission: record returned 422"],
        at: "2026-10-24T03:18:00.000Z",
      },
    });

    const out = await world.call("extension_submit", { ...ARGS, waitSeconds: 5 });
    const context = JSON.stringify(out).slice(0, 2000);

    expect(out.value.outcome.recorded, context).toBe(true);
    expect(out.value.outcome.status).toBe("uploaded");
    expect(out.value.nextStep.kind).toBe("watch");
    expect(out.value.nextStep.say).toContain("a later step of the run failed: Record the store submission");
    expect(out.value.nextStep.say).toContain("do not submit the same build again");
    expect(out.value.sayToPerson).toBe(out.value.nextStep.say);
    expect(out.hint).toContain("Record the store submission");
    expect(JSON.stringify(out)).not.toMatch(MIRROR);
  });

  it("keeps the draft sentence once the record reads draft", async () => {
    if (process.platform === "win32") return;

    world.login();
    approvedEdgeSubmit(world, { status: "draft" });

    const out = await world.call("extension_submit", { ...ARGS, waitSeconds: 5 });

    expect(out.value.outcome.recorded).toBe(true);
    expect(out.value.nextStep.kind).toBe("done");
    expect(out.value.nextStep.say).toContain("recorded as uploaded and not public");
  });
});

describe("480: a Chrome upload under a saved mode that publishes is never a draft to publish by hand", () => {
  const world = usePlatformWorld("extdev-chrome-public-mode-");
  const PREFLIGHT = new RegExp(`^POST /api/projects/${WORLD_PROJECT_ID}/stores/chrome/submissions/preflight$`);
  const CHROME_ARGS = { ...ARGS, browsers: ["chrome"], approvalId: "apr_chrome" };
  const DRAFT = { status: "draft", storeUpload: { state: "SUCCEEDED" }, storeReview: { state: "NO_ACTIVE_SUBMISSION" } };
  const REVIEWING = {
    status: "submitted",
    storeUpload: { state: "SUCCEEDED" },
    storeReview: { state: "PENDING_REVIEW" },
    publish: { act: "publish", status: "in-review", storeMessage: "Chrome holds package 0.3.1 in review (PENDING_REVIEW)." },
  };

  function publicChromeSubmit(records: () => Record<string, unknown>): void {
    world.routes.push([
      PREFLIGHT,
      () => ({
        body: {
          store: "chrome",
          summary: { pass: 1, warn: 0, fail: 0, blockingFailures: 0, canSubmit: true },
          checks: [],
          submissionMode: { id: "public", label: "Public", description: "Published to everyone after review.", rollout: "broad" },
        },
      }),
    ]);

    world.routes.push([
      /^GET \/api\/cli\/approvals\/apr_chrome$/,
      () => ({
        body: {
          status: "approved",
          used: false,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          fingerprint: actionFingerprint("extension_submit", { browsers: ["chrome"], buildSha: "f29f204" }),
        },
      }),
    ]);

    world.routes.push([
      SUBMIT,
      () => ({ body: { ok: true, buildId: "f29f204", dispatchedAt: "2026-11-09T18:45:24.000Z", submissions: [{ id: "sub_chrome", store: "chrome", status: "pending" }] } }),
    ]);

    world.routes.push([RECORDS, () => ({ body: { submissions: [{ id: "sub_chrome", store: "chrome", ...records() }] } })]);
  }

  async function withFakeClock<T>(run: () => Promise<T>): Promise<T> {
    const real = { now: outcomeClock.now, sleep: outcomeClock.sleep };
    let now = Date.parse("2026-11-09T18:45:25.000Z");
    outcomeClock.now = () => now;

    outcomeClock.sleep = async (ms) => {
      now += ms;
    };

    try {
      return await run();
    } finally {
      outcomeClock.now = real.now;
      outcomeClock.sleep = real.sleep;
    }
  }

  it("keeps waiting past the draft the run records before its publish step, then says the run sent it to review", async () => {
    if (process.platform === "win32") return;

    world.login();
    let reads = 0;
    publicChromeSubmit(() => {
      reads += 1;

      return reads < 3 ? DRAFT : REVIEWING;
    });

    const out = await withFakeClock(() => world.call("extension_submit", { ...CHROME_ARGS, waitSeconds: 60 }));
    const context = JSON.stringify(out).slice(0, 2500);

    expect(out.status, context).toBe("submitted");
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "submitted" });
    expect(out.value.outcomes.chrome.status).toBe("submitted");
    expect(out.value.nextStep.kind).toBe("done");
    expect(out.value.nextStep.say).toContain('under the Chrome Web Store\'s saved mode "public", the same run sent it on to review; no publish approval is needed');
    expect(out.value.nextStep.say).toContain("extension_release_status (include: ['stores'])");
    expect(JSON.stringify(out.value.nextStep)).not.toContain(PUBLISH_SENTENCE);
    expect(out.value.sayToPerson).toBe(out.value.nextStep.say);
    expect(JSON.stringify(out)).not.toMatch(MIRROR);
  });

  it("says the run publishes next and never asks for a publish approval when the wait ends on the draft", async () => {
    if (process.platform === "win32") return;

    world.login();
    publicChromeSubmit(() => DRAFT);

    const out = await withFakeClock(() => world.call("extension_submit", { ...CHROME_ARGS, waitSeconds: 0 }));
    const context = JSON.stringify(out).slice(0, 2500);

    expect(out.value.outcome.recorded, context).toBe(false);
    expect(out.value.nextStep.kind).toBe("watch");
    expect(out.value.nextStep.say).toContain('under the Chrome Web Store\'s saved mode "public" the run sends it on to review next');
    expect(out.value.nextStep.say).toContain("do not ask for a publish approval");
    expect(JSON.stringify(out.value.nextStep)).not.toContain(PUBLISH_SENTENCE);
    expect(JSON.stringify(out)).not.toMatch(MIRROR);
  });
});
