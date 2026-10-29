// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import {
  OUTCOME_POLL_MS,
  WAIT_SECONDS_DEFAULT,
  awaitRecordedOutcome,
  dispatchedHint,
  linksOf,
  madeSentence,
  missedRead,
  outcomeClock,
  waitBound,
} from "../lib/act-outcome";
import { handler as builds } from "../tools/builds";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const FULL_SHA = "603fc8a".padEnd(40, "0");

describe("waitSeconds is a bounded wait", () => {
  it("defaults to 180 and clamps to 0..600", () => {
    expect(waitBound(undefined)).toBe(WAIT_SECONDS_DEFAULT);
    expect(waitBound("abc")).toBe(WAIT_SECONDS_DEFAULT);
    expect(waitBound(0)).toBe(0);
    expect(waitBound(-5)).toBe(0);
    expect(waitBound("42")).toBe(42);
    expect(waitBound(9000)).toBe(600);
  });
});

describe("awaitRecordedOutcome reads the platform's record until it shows the act's result", () => {
  it("polls every five seconds and answers the recorded status with the time it took", async () => {
    let reads = 0;
    const slept: number[] = [];
    const sleep = outcomeClock.sleep;

    outcomeClock.sleep = async (ms) => {
      slept.push(ms);
      await sleep(ms);
    };

    try {
      const out = await awaitRecordedOutcome<{ status: string }>({
        waitSeconds: 60,
        read: async () => {
          reads += 1;

          return { ok: true, record: { status: reads < 3 ? "pending" : "submitted" } };
        },
        judge: (record) => (record.status === "pending" ? { kind: "waiting", status: record.status } : { kind: "recorded", status: record.status, storeState: "SUCCEEDED" }),
      });

      expect(reads).toBe(3);
      expect(slept).toEqual([OUTCOME_POLL_MS, OUTCOME_POLL_MS]);
      expect(out.outcome).toMatchObject({ recorded: true, status: "submitted", storeState: "SUCCEEDED", source: "platform-record", waitedSeconds: 10 });
      expect(out.failed).toBe(false);
    } finally {
      outcomeClock.sleep = sleep;
    }
  });

  it("stops at the bound and answers recorded false with the last status it saw", async () => {
    let reads = 0;
    const out = await awaitRecordedOutcome<{ status: string }>({
      waitSeconds: 12,
      read: async () => {
        reads += 1;

        return { ok: true, record: { status: "pending" } };
      },
      judge: (record) => ({ kind: "waiting", status: record.status }),
    });

    expect(reads).toBe(4);
    expect(out.outcome).toMatchObject({ recorded: false, status: "pending", storeState: null, waitedSeconds: 12 });
  });

  it("reads once with waitSeconds 0, and stops on a read that fails, naming the problem", async () => {
    let reads = 0;
    const once = await awaitRecordedOutcome<{ status: string }>({
      waitSeconds: 0,
      read: async () => {
        reads += 1;

        return { ok: true, record: null };
      },
      judge: () => ({ kind: "waiting" }),
    });

    expect(reads).toBe(1);
    expect(once.outcome.recorded).toBe(false);

    const failed = await awaitRecordedOutcome<{ status: string }>({
      waitSeconds: 60,
      read: async () => ({ ok: false, message: "the record read answered 503" }),
      judge: () => ({ kind: "waiting" }),
    });

    expect(failed.outcome).toMatchObject({ recorded: false, readProblem: "the record read answered 503", waitedSeconds: 0 });
  });

  it("retries a read the platform did not answer while the bound lasts, and answers the recorded result after it", async () => {
    let reads = 0;
    const slept: number[] = [];
    const sleep = outcomeClock.sleep;

    outcomeClock.sleep = async (ms) => {
      slept.push(ms);
      await sleep(ms);
    };

    try {
      const out = await awaitRecordedOutcome<{ status: string }>({
        waitSeconds: 300,
        read: async () => {
          reads += 1;
          if (reads === 1) return missedRead({ status: 0, message: "could not reach https://api.test/api/cli/stores/submissions: the platform did not answer within 15 s" });
          if (reads === 2) return missedRead({ status: 429, message: "https://api.test/api/cli/stores/submissions answered 429", retryAfterSeconds: 20 });

          return { ok: true, record: { status: "failed" } };
        },
        judge: (record) => ({ kind: "recorded", status: record.status, failed: true }),
      });

      expect(reads).toBe(3);
      expect(slept).toEqual([OUTCOME_POLL_MS, 20_000]);
      expect(out.failed).toBe(true);
      expect(out.outcome).toMatchObject({ recorded: true, status: "failed", waitedSeconds: 25, readMisses: 2 });
      expect(out.outcome.readProblem).toBeUndefined();
    } finally {
      outcomeClock.sleep = sleep;
    }
  });

  it("names the misses in readProblem only once the bound is spent on them, and keeps a refused read as the end", async () => {
    let reads = 0;
    const spent = await awaitRecordedOutcome<{ status: string }>({
      waitSeconds: 20,
      read: async () => {
        reads += 1;

        return missedRead({ status: 503, message: "https://api.test/api/cli/stores/submissions answered 503" });
      },
      judge: () => ({ kind: "waiting" }),
    });

    expect(reads).toBe(5);
    expect(spent.outcome).toMatchObject({
      recorded: false,
      status: null,
      waitedSeconds: 20,
      readMisses: 5,
      readProblem: "https://api.test/api/cli/stores/submissions answered 503; 5 reads of the record missed over 20 s",
    });

    reads = 0;
    const once = await awaitRecordedOutcome<{ status: string }>({
      waitSeconds: 0,
      read: async () => {
        reads += 1;

        return missedRead({ status: 0, message: "could not reach https://api.test/x: the connection was refused by api.test (ECONNREFUSED)" });
      },
      judge: () => ({ kind: "waiting" }),
    });

    expect(reads).toBe(1);
    expect(once.outcome.readProblem).toBe("could not reach https://api.test/x: the connection was refused by api.test (ECONNREFUSED); 1 read of the record missed over 0 s");

    reads = 0;
    const refused = await awaitRecordedOutcome<{ status: string }>({
      waitSeconds: 300,
      read: async () => {
        reads += 1;

        return missedRead({ status: 401, message: "https://api.test/api/cli/stores/submissions answered 401" });
      },
      judge: () => ({ kind: "waiting" }),
    });

    expect(reads).toBe(1);
    expect(refused.outcome).toMatchObject({ recorded: false, readProblem: "https://api.test/api/cli/stores/submissions answered 401", waitedSeconds: 0 });
    expect(refused.outcome.readMisses).toBeUndefined();
  });

  it("stops early when the record says nothing more will be recorded, and marks a recorded failure", async () => {
    const stopped = await awaitRecordedOutcome<{ status: string }>({
      waitSeconds: 60,
      read: async () => ({ ok: true, record: { status: "submitted" } }),
      judge: (record) => ({ kind: "unrecorded", status: record.status }),
    });

    expect(stopped.outcome).toMatchObject({ recorded: false, status: "submitted", waitedSeconds: 0 });

    const failed = await awaitRecordedOutcome<{ status: string }>({
      waitSeconds: 60,
      read: async () => ({ ok: true, record: { status: "failed" } }),
      judge: (record) => ({ kind: "recorded", status: record.status, failed: true }),
    });

    expect(failed.failed).toBe(true);
    expect(failed.outcome).toMatchObject({ recorded: true, status: "failed" });
  });
});

describe("links name every URL an act made or touched", () => {
  it("fills audience and expiry defaults, drops empty urls, and lets a specific kind win over track on the same url", () => {
    const links = linksOf([
      { kind: "track", url: "https://console.test/acme/widget/submissions/chrome/sub_1" },
      { kind: "submission", url: "https://console.test/acme/widget/submissions/chrome/sub_1", made: true },
      { kind: "item", url: "" },
      { kind: "share", url: "https://acme.extension.dev/widget/builds/abc?share=k3x9q", expiresAt: "2026-10-27T10:00:00.000Z", made: true },
    ]);

    expect(links).toEqual([
      { kind: "submission", url: "https://console.test/acme/widget/submissions/chrome/sub_1", audience: "workspace members", expiresAt: null, made: true },
      { kind: "share", url: "https://acme.extension.dev/widget/builds/abc?share=k3x9q", audience: "anyone with the link", expiresAt: "2026-10-27T10:00:00.000Z", made: true },
    ]);

    expect(madeSentence(links)).toBe("Made: the tester link (expires October 27) and the submission page.");
    expect(madeSentence(linksOf([{ kind: "track", url: "https://console.test/x" }]))).toBe("Made: no new links.");
    expect(madeSentence(linksOf([{ kind: "submission", url: "https://console.test/a", made: true }, { kind: "submission", url: "https://console.test/b", made: true }]))).toBe("Made: 2 submission pages.");
  });

  it("says exactly how a dispatched act is read later", () => {
    expect(dispatchedHint({ acceptedAt: "2026-10-20T12:37:00.000Z", trackUrl: "https://console.test/p", readCall: 'extension_release_status (include: ["stores"])' })).toBe(
      'The platform accepted the act at 2026-10-20T12:37:00.000Z; its record has not confirmed the result yet. Watch https://console.test/p; call extension_release_status (include: ["stores"]) to read it.',
    );
  });
});

describe("store acts and builds answer the recorded outcome", () => {
  const platform = useProjectRoutes("extdev-act-outcome-");

  it("cancel answers canceled once the record leaves the live statuses, and cancel-dispatched before", async () => {
    if (process.platform === "win32") return;

    platform.login();
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.routes[`POST ${PROJECT_ROUTE}/stores/chrome/submissions/sub_7/cancel`] = () => ({ body: { ok: true, dispatched: true, store: "chrome", submissionId: "sub_7" } });
    let reads = 0;

    platform.routes["GET /api/cli/stores/submissions"] = () => {
      reads += 1;

      return { body: { submissions: [{ id: "sub_7", store: "chrome", status: reads < 3 ? "submitted" : "withdrawn" }] } };
    };

    const out = JSON.parse(await submit({ action: "cancel", submissionId: "sub_7", approvalId: "apr_c", api: API }));

    expect(out.status).toBe("canceled");
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "withdrawn", waitedSeconds: 10 });
    expect(out.value.links).toEqual([{ kind: "submission", url: expect.stringMatching(/\/submissions\/chrome\/sub_7$/), audience: "workspace members", expiresAt: null, made: false }]);
    expect(out.hint).toContain("Made: no new links.");

    reads = -100;
    const early = JSON.parse(await submit({ action: "cancel", submissionId: "sub_7", approvalId: "apr_c", waitSeconds: 0, api: API }));

    expect(early.status).toBe("cancel-dispatched");
    expect(early.value.outcome).toMatchObject({ recorded: false, status: "submitted" });
    expect(early.hint).toContain("its record has not confirmed the result yet");
  });

  it("rollout answers rolled-out when the rollout record reads the asked percentage", async () => {
    if (process.platform === "win32") return;

    platform.login();
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.routes[`POST ${PROJECT_ROUTE}/stores/chrome/rollout`] = () => ({ body: { ok: true, dispatched: true, store: "chrome", deployPercentage: 50 } });
    platform.routes[`GET ${PROJECT_ROUTE}/stores/chrome/rollout`] = () => ({ body: { rollout: { stagedPublish: true, percentage: 50, canRaise: true } } });

    const out = JSON.parse(await submit({ action: "rollout", deployPercentage: 50, approvalId: "apr_r", api: API }));

    expect(out.status).toBe("rolled-out");
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "rollout-raised", storeState: "50%" });
    expect(out.value.links[0]).toMatchObject({ kind: "track", url: expect.stringMatching(/\/submissions\/chrome$/) });
  });

  it("a real submit answers submit-failed when the record reads failed, with the store's reason", async () => {
    if (process.platform === "win32") return;

    platform.login();
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.routes["POST /api/cli/stores/submit"] = () => ({ body: { ok: true, submissions: [{ id: "sub_9", store: "chrome", status: "pending" }] } });
    platform.routes["GET /api/cli/stores/submissions"] = () => ({ body: { submissions: [{ id: "sub_9", store: "chrome", status: "failed", failureReason: "The run died before the store step." }] } });

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "b418732", dryRun: false, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("submit-failed");
    expect(out.error.message).toContain("chrome: The run died before the store step.");
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "failed" });
    expect(out.value.links[0]).toMatchObject({ kind: "submission", made: true });
    expect(out.value.nextStep.kind).toBe("resubmit");
    expect(out.value.nextStep.say).toContain("did not reach the Chrome Web Store; nothing is in review");
    expect(out.value.nextStep.say).toContain("The store answered: chrome: The run died before the store step. Fix the cause");
    expect(out.value.nextStep.say).not.toContain("recorded the submission");
    expect(out.value.nextStep.say).not.toContain("review comes after this");
    expect(out.value.sayToPerson).toBe(out.value.nextStep.say);
    expect(out.value.nextStep.url).toMatch(/\/submissions\//);
  });

  it("a listed Firefox upload AMO refused answers the store's own words in the next step", async () => {
    if (process.platform === "win32") return;

    platform.login();
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    const reason =
      'HTTP 400 Bad Request, POST https://addons.mozilla.org/api/v5/addons/addon/rebeccat@extension.dev/versions/ {"license":["This field, or custom_license, is required for listed versions."]}';
    platform.routes["POST /api/cli/stores/submit"] = () => ({ body: { ok: true, submissions: [{ id: "sub_ff", store: "firefox", status: "pending" }] } });
    platform.routes["GET /api/cli/stores/submissions"] = () => ({ body: { submissions: [{ id: "sub_ff", store: "firefox", status: "failed", failureReason: reason }] } });

    const out = JSON.parse(await submit({ browsers: ["firefox"], buildSha: "6d9e10c", dryRun: false, api: API }));

    expect(out.status).toBe("submit-failed");
    expect(out.value.nextStep.kind).toBe("resubmit");
    expect(out.value.nextStep.say).toContain("did not reach Firefox AMO; nothing is in review");
    expect(out.value.nextStep.say).toContain("required for listed versions");
    expect(out.value.nextStep.say).toContain("submit the same build again");
    expect(out.value.nextStep.say).not.toContain("review comes after this");
    expect(JSON.stringify(out)).not.toMatch(/extension-user-land-dev|\/actions\/runs\//);
  });

  it("a real submit answers the version the store received once the record names it, where the dispatch answer had none", async () => {
    if (process.platform === "win32") return;

    platform.login();
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    const received = { packaged: "0.2.0.8", displayed: "0.2.0", source: "platform", buildNumber: 8 };
    platform.routes["POST /api/cli/stores/submit"] = () => ({
      body: { ok: true, submissions: [{ id: "sub_ff8", store: "firefox", status: "pending", storeVersion: null }] },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: "sub_ff8", store: "firefox", status: "submitted", storeVersion: received }] },
    });

    const out = JSON.parse(await submit({ browsers: ["firefox"], buildSha: "069d4b8", dryRun: false, api: API }));

    expect(out.value.outcome).toMatchObject({ recorded: true, storeVersions: { firefox: "0.2.0.8" } });
    expect(out.value.submissions[0].storeVersion).toEqual(received);
    expect(out.value.outcomes.firefox).toMatchObject({ recorded: true, status: "submitted", storeVersion: "0.2.0.8", submissionId: "sub_ff8" });
  });

  it("rebuild answers built when the build record shows this run finished, and build-failed when it failed", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/builds/dispatch`] = () => ({
      body: { ok: true, commit: FULL_SHA, browsers: "chrome", branch: "main", deploymentId: "dep_9", dispatchedAt: "2026-10-20T10:05:00.000Z" },
    });

    let reads = 0;

    platform.routes[`GET ${PROJECT_ROUTE}/builds/${FULL_SHA}`] = () => {
      reads += 1;

      return reads < 2
        ? { body: { buildId: "603fc8a", status: "success", deploymentId: "dep_1", startedAt: "2026-10-20T09:00:00.000Z" } }
        : { body: { buildId: "603fc8a", status: "success", deploymentId: "dep_9", startedAt: "2026-10-20T10:05:30.000Z" } };
    };

    const out = JSON.parse(await builds({ action: "rebuild", buildId: FULL_SHA, api: API }));

    expect(out.status).toBe("built");
    expect(reads).toBe(2);
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "success", waitedSeconds: 5 });
    expect(out.value.links).toEqual([{ kind: "build", url: expect.stringMatching(/\/acme\/widget\/builds\/603fc8a$/), audience: "workspace members", expiresAt: null, made: false }]);
    expect(out.hint).toContain("now reads success");

    platform.routes[`GET ${PROJECT_ROUTE}/builds/${FULL_SHA}`] = () => ({ body: { buildId: "603fc8a", status: "failed", deploymentId: "dep_9", startedAt: "2026-10-20T10:05:30.000Z" } });
    const failed = JSON.parse(await builds({ action: "rebuild", buildId: FULL_SHA, api: API }));

    expect(failed.ok).toBe(false);
    expect(failed.status).toBe("build-failed");
    expect(failed.value.outcome).toMatchObject({ recorded: true, status: "failed" });
    expect(failed.hint).toContain('action:"logs"');
  });
});
