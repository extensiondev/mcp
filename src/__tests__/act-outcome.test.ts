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
import { withCallMemory } from "../lib/call-memory";
import { underCallDeadline, withCallDeadline, type CallDeadline } from "../lib/outcome-clock";
import { handler as builds } from "../tools/builds";
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

describe("a host that ends every call at a fixed time cuts every wait to the time it has left", () => {
  const pending = { read: async () => ({ ok: true as const, record: { status: "pending" } }), judge: (record: { status: string }) => ({ kind: "waiting" as const, status: record.status }) };

  it("cuts an asked wait and the 180 s default alike, records each cut, and leaves a wait that fits alone", async () => {
    const deadline: CallDeadline = { waitsEndAt: outcomeClock.now() + 40_500, dispatchesEndAt: outcomeClock.now() + 45_000, readsEndAt: outcomeClock.now() + 52_000, cuts: [] };
    const defaulted = await withCallDeadline(deadline, () => awaitRecordedOutcome({ waitSeconds: undefined, ...pending }));

    expect(defaulted.outcome).toMatchObject({ recorded: false, waitedSeconds: 40 });
    expect(deadline.cuts).toMatchObject([{ askedSeconds: 180, grantedSeconds: 40 }]);
    expect(outcomeClock.now()).toBeGreaterThanOrEqual(deadline.cuts[0]!.until);
    expect(withCallDeadline({ ...deadline, waitsEndAt: outcomeClock.now() + 40_500, cuts: [] }, () => [waitBound(600), waitBound(12), waitBound(0)])).toEqual([40, 12, 0]);
    expect(waitBound(undefined)).toBe(WAIT_SECONDS_DEFAULT);
  });

  it("gives a platform request the time left for its kind, a dispatch less than a read, and its whole budget with no host limit", () => {
    const now = outcomeClock.now();
    const deadline: CallDeadline = { waitsEndAt: now + 40_000, dispatchesEndAt: now + 45_000, readsEndAt: now + 52_000, cuts: [] };

    expect(withCallDeadline(deadline, () => [underCallDeadline("dispatch", 90_000), underCallDeadline("dispatch", 60_000), underCallDeadline("read", 15_000)]).map((ms) => Math.ceil(ms / 1000))).toEqual([45, 45, 15]);
    expect(Math.ceil(withCallDeadline({ ...deadline, readsEndAt: now + 9_000 }, () => underCallDeadline("read", 15_000)) / 1000)).toBe(9);
    expect(underCallDeadline("dispatch", 90_000)).toBe(90_000);
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

  it("carries the audience a record names on a channel link, and defaults it only when the record names none", () => {
    const url = "https://acme.extension.dev/widget/channels/stable";
    const recorded = linksOf([{ kind: "channel", channel: "stable", url, audience: "workspace members", made: true, at: "2026-11-03T12:00:00.000Z", buildId: "abc1234" }]);

    expect(recorded).toEqual([{ kind: "channel", channel: "stable", url, audience: "workspace members", expiresAt: null, made: true, at: "2026-11-03T12:00:00.000Z", buildId: "abc1234" }]);
    expect(linksOf([{ kind: "channel", url, audience: "" }])[0]?.audience).toBe("anyone with the link");
    expect(linksOf([{ kind: "channel", url }])[0]?.audience).toBe("anyone with the link");
  });

  it("says exactly how a dispatched act is read later", () => {
    expect(dispatchedHint({ acceptedAt: "2026-10-20T12:37:00.000Z", trackUrl: "https://console.test/p", readCall: 'extension_release_status (include: ["stores"])' })).toBe(
      'The platform accepted the act at 2026-10-20T12:37:00.000Z; its record has not confirmed the result yet. Watch https://console.test/p; call extension_release_status (include: ["stores"]) to read it.',
    );
  });
});
