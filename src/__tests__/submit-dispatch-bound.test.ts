import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLATFORM_DISPATCH_TIMEOUT_MS } from "../lib/platform-fetch";
import {
  SUBMIT_DISPATCH_CEILING_MS,
  readStoresAfterUnconfirmed,
  submitDispatchBoundMs,
  unconfirmedStoresHint,
} from "../lib/submit-dispatch-bound";
import { submitAnswer } from "./fixtures/platform-answers";

import type * as PlatformFetchModule from "../lib/platform-fetch";

const seen = vi.hoisted(() => ({
  bounds: [] as Array<number | undefined>,
  timeoutSubmit: false,
}));

vi.mock("../lib/platform-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformFetchModule>();

  return {
    ...actual,
    platformFetch: async (url: string, init: RequestInit, options: PlatformFetchModule.PlatformFetchOptions = {}) => {
      if (url.endsWith("/api/cli/stores/submit")) {
        seen.bounds.push(options.boundMs);

        if (seen.timeoutSubmit) {
          const boundMs = options.boundMs ?? actual.PLATFORM_DISPATCH_TIMEOUT_MS;

          return {
            ok: false,
            unreached: { kind: "timeout", message: `could not reach ${url}: the platform did not answer within ${Math.round(boundMs / 1000)} s` },
          };
        }
      }

      return actual.platformFetch(url, init, options);
    },
  };
});

const { handler } = await import("../tools/submit");

const API = "https://api.test";
const saved: Record<string, string | undefined> = {};
let tmp: string;

type Row = Record<string, unknown>;

function stubPlatform(submissions: Row[] | (() => Response), submitBody: unknown = submitAnswer(["chrome"])) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const href = String(url);

      if (href.endsWith("/api/cli/stores/submit")) {
        return new Response(JSON.stringify(submitBody), { status: 200 });
      }

      if (href.includes("/api/cli/stores/submissions")) {
        if (typeof submissions === "function") return submissions();

        return new Response(JSON.stringify({ submissions }), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${href}`);
    }),
  );
}

function recorded(store: string, index: number, submittedAt: string): Row {
  return {
    id: `sub-${store}-${index}`,
    store,
    channel: "stable",
    buildId: "8789cce",
    version: `0.3.0.${10 + index}`,
    status: "submitted",
    submittedAt,
    workflowRunId: 1000 + index,
    origin: "mcp",
  };
}

async function submit(browsers: string[], extra: Record<string, unknown> = {}) {
  return JSON.parse(
    await handler({
      browsers,
      buildSha: "8789cce",
      dryRun: false,
      projectPath: tmp,
      ...extra,
    } as never),
  );
}

beforeEach(() => {
  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_APPROVAL_GATE"]) {
    saved[key] = process.env[key];
  }

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-submit-bound-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  process.env.EXTENSION_DEV_TOKEN = "release-token";
  process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
  seen.bounds.length = 0;
  seen.timeoutSubmit = false;
});

afterEach(() => {
  vi.unstubAllGlobals();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the submit dispatch bound scales with the stores asked (ledger 445)", () => {
  it.each([
    ["three stores and no waitSeconds", 3, undefined, 180_000],
    ["three stores bounded by waitSeconds 100", 3, 100, 100_000],
    ["one store keeps the plain dispatch bound", 1, undefined, PLATFORM_DISPATCH_TIMEOUT_MS],
    ["waitSeconds 0 never drops below the plain dispatch bound", 3, 0, PLATFORM_DISPATCH_TIMEOUT_MS],
    ["waitSeconds as a string is read", 4, "90", 90_000],
    ["many stores stop at the ceiling", 20, 900, SUBMIT_DISPATCH_CEILING_MS],
  ])("%s", (_label, stores, waitSeconds, expected) => {
    expect(submitDispatchBoundMs(stores, waitSeconds)).toBe(expected);
  });

  it("hands the platform fetch 180 s for a three-store submit and 60 s for one store", async () => {
    stubPlatform([recorded("chrome", 1, "2026-11-06T16:18:15.000Z")], submitAnswer(["chrome", "edge", "firefox"]));
    await submit(["chrome", "edge", "firefox"], { waitSeconds: 0 });
    await submit(["chrome", "edge", "firefox"]);
    await submit(["chrome"], { waitSeconds: 0 });

    expect(seen.bounds).toEqual([PLATFORM_DISPATCH_TIMEOUT_MS, 180_000, PLATFORM_DISPATCH_TIMEOUT_MS]);
  });

  it("leaves the dry run on the plain dispatch bound", async () => {
    stubPlatform([], { ok: true, dryRun: true, checks: [] });
    await submit(["chrome", "edge", "firefox"], { dryRun: true });

    expect(seen.bounds).toEqual([undefined]);
  });
});

describe("an unconfirmed submit reads the per-store records before answering (ledger 445)", () => {
  it("names the stores that went out and the one that did not", async () => {
    seen.timeoutSubmit = true;
    const soon = new Date(Date.now() + 20_000).toISOString();
    const later = new Date(Date.now() + 37_000).toISOString();
    stubPlatform([
      recorded("chrome", 10, soon),
      recorded("edge", 11, later),
      recorded("firefox", 2, "2026-11-01T10:00:00.000Z"),
    ]);

    const out = await submit(["chrome", "edge", "firefox"], { waitSeconds: 600 });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("submit-unconfirmed");
    expect(out.error.code).toBe("E_NETWORK");
    expect(out.error.message).toContain("no answer came back");
    expect(out.error.message).toContain("did not answer within 180 s");
    expect(out.value.stores.chrome).toEqual({ submitted: true, submissionId: "sub-chrome-10", version: "0.3.0.20", submittedAt: soon });
    expect(out.value.stores.edge).toEqual({ submitted: true, submissionId: "sub-edge-11", version: "0.3.0.21", submittedAt: later });
    expect(out.value.stores.firefox).toEqual({ submitted: false });
    expect(out.value.submittedStores).toEqual(["chrome", "edge"]);
    expect(out.value.missingStores).toEqual(["firefox"]);
    expect(out.hint).toContain("Do not submit again blind");
    expect(out.hint).toContain("chrome, edge went out (chrome sub-chrome-10, version 0.3.0.20");
    expect(out.hint).toContain("firefox has no submission newer than this call");
    expect(out.hint).toContain("browsers limited to firefox");
    expect(out.hint).toContain("never repeat chrome, edge");
    expect(out.hint).toContain("extension_release_status");
  });

  it("says nothing is left to submit when every store asked went out", async () => {
    seen.timeoutSubmit = true;
    const now = new Date().toISOString();
    stubPlatform([recorded("chrome", 1, now), recorded("edge", 2, now)]);

    const out = await submit(["chrome", "edge"]);

    expect(out.status).toBe("submit-unconfirmed");
    expect(out.value.missingStores).toEqual([]);
    expect(out.hint).toContain("Every store asked went out");
    expect(out.hint).toContain("nothing is left to submit");
  });

  it("says the platform may still be uploading when no store has a newer record", async () => {
    seen.timeoutSubmit = true;
    stubPlatform([recorded("chrome", 1, "2026-11-01T10:00:00.000Z")]);

    const out = await submit(["chrome", "firefox"]);

    expect(out.status).toBe("submit-unconfirmed");
    expect(out.value.stores).toEqual({ chrome: { submitted: false }, firefox: { submitted: false } });
    expect(out.hint).toContain("None of chrome, firefox has a submission newer than this call");
    expect(out.hint).toContain("may still be uploading");
    expect(out.hint).toContain("submit again only the stores that still show none");
  });

  it("falls back to the plain read-first hint when the records cannot be read", async () => {
    seen.timeoutSubmit = true;
    stubPlatform(() => new Response("down", { status: 503 }));

    const out = await submit(["chrome", "firefox"]);

    expect(out.status).toBe("submit-unconfirmed");
    expect(out.value.readProblem).toBeTruthy();
    expect(out.value.stores).toEqual({});
    expect(out.hint).toContain("Do not submit again blind");
    expect(out.hint).toContain("could not be read after the cut");
    expect(out.hint).toContain("extension_release_status");
  });

  it("counts a record stamped a little before the call as newer, for clock skew", async () => {
    const startedAt = Date.now();
    stubPlatform([recorded("chrome", 1, new Date(startedAt - 10_000).toISOString()), recorded("edge", 2, new Date(startedAt - 60_000).toISOString())]);

    const read = await readStoresAfterUnconfirmed({
      api: { base: API, token: "release-token", command: "extension_submit" },
      browsers: ["chrome", "edge"],
      startedAt,
    });

    expect(read.went).toEqual(["chrome"]);
    expect(read.stayed).toEqual(["edge"]);
    expect(unconfirmedStoresHint(read, "the read")).toContain("chrome went out");
  });
});
