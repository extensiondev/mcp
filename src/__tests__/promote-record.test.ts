// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { awaitPromoteRecord, judgeRelease, recordedAfterDispatch } from "../lib/promote-record";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const BUILD_COMPLETED_AT = "2026-11-03T22:57:12.000Z";
const DISPATCHED_AT = "2026-11-04T00:00:05.000Z";
const SINCE = new Date(Date.parse(DISPATCHED_AT) - 60_000).toISOString();
const EVENT_AT = "2026-11-04T00:00:25.000Z";

const tonightsRow = (over: Record<string, unknown> = {}) => ({
  id: "stable-chrome-6f72a7b",
  browser: "chrome",
  channel: "stable",
  build: "6f72a7b",
  version: "0.1.0",
  status: "live",
  rollout: "100%",
  health: "good",
  createdAt: BUILD_COMPLETED_AT,
  timestamp: BUILD_COMPLETED_AT,
  promotedAt: EVENT_AT,
  promotion: { verified: true, runId: 41745, runStatus: "completed", runConclusion: "success" },
  ...over,
});

describe("recordedAfterDispatch reads the promotion's own time before the build's", () => {
  it("accepts tonight's record: createdAt hours before the dispatch, promotedAt after it", () => {
    expect(recordedAfterDispatch(tonightsRow(), SINCE)).toBe(true);
  });

  it("refuses a promotedAt from before the dispatch even when the run is verified", () => {
    expect(recordedAfterDispatch(tonightsRow({ promotedAt: "2026-11-01T10:00:00.000Z" }), SINCE)).toBe(false);
  });

  it("falls back to a verified completed promotion run when the row carries no promotedAt", () => {
    expect(recordedAfterDispatch(tonightsRow({ promotedAt: undefined }), SINCE)).toBe(true);
    expect(recordedAfterDispatch(tonightsRow({ promotedAt: undefined, promotion: { verified: true, runStatus: "in_progress" } }), SINCE)).toBe(false);
    expect(recordedAfterDispatch(tonightsRow({ promotedAt: undefined, promotion: { verified: false, dispatched: true } }), SINCE)).toBe(false);
  });

  it("only then compares createdAt or startedAt to the dispatch, as before", () => {
    expect(recordedAfterDispatch(tonightsRow({ promotedAt: undefined, promotion: undefined }), SINCE)).toBe(false);
    expect(recordedAfterDispatch(tonightsRow({ promotedAt: undefined, promotion: undefined, createdAt: EVENT_AT }), SINCE)).toBe(true);
    expect(recordedAfterDispatch(tonightsRow({ promotedAt: undefined, promotion: undefined, createdAt: undefined, startedAt: EVENT_AT }), SINCE)).toBe(true);
    expect(recordedAfterDispatch(tonightsRow({ promotedAt: undefined, promotion: undefined, createdAt: undefined }), SINCE)).toBe(true);
  });
});

describe("judgeRelease never records a verdict the platform has not proven", () => {
  it("keeps waiting on promoting and unconfirmed rows", () => {
    expect(judgeRelease({ status: "promoting" })).toEqual({ kind: "waiting", status: "promoting" });
    expect(judgeRelease({ status: "unconfirmed" })).toEqual({ kind: "waiting", status: "unconfirmed" });
    expect(judgeRelease({ status: "live" })).toEqual({ kind: "recorded", status: "live" });
    expect(judgeRelease({ status: "failed" })).toEqual({ kind: "recorded", status: "failed", failed: true });
  });
});

describe("awaitPromoteRecord answers the recorded outcome of a promote of an already built sha", () => {
  const routes = useProjectRoutes("extdev-promote-record-");

  it("records live from tonight's row instead of waiting out the bound", async () => {
    routes.login();
    routes.routes[`GET ${PROJECT_ROUTE}/releases`] = () => ({ body: { items: [tonightsRow()] } });

    const out = await awaitPromoteRecord({ command: "extension_release_promote", api: API, channel: "stable", buildId: "6f72a7b", acceptedAt: DISPATCHED_AT, waitSeconds: 0 });

    expect(out.outcome).toMatchObject({ recorded: true, status: "live", waitedSeconds: 0 });
    expect(out.record?.id).toBe("stable-chrome-6f72a7b");
    expect(out.failed).toBe(false);
  });

  it("still answers dispatched for the same build's row from an older promote", async () => {
    routes.login();
    routes.routes[`GET ${PROJECT_ROUTE}/releases`] = () => ({
      body: { items: [tonightsRow({ promotedAt: "2026-11-01T10:00:00.000Z", promotion: { verified: false, dispatched: true }, status: "unconfirmed" })] },
    });

    const out = await awaitPromoteRecord({ command: "extension_release_promote", api: API, channel: "stable", buildId: "6f72a7b", acceptedAt: DISPATCHED_AT, waitSeconds: 0 });

    expect(out.outcome.recorded).toBe(false);
    expect(out.record).toBeNull();
  });
});
