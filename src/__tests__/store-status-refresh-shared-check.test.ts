import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { readStores } from "../tools/store-status";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_rebeccat";
const BEFORE = "2026-10-31T14:50:00.000Z";
const DISPATCHED_AT = "2026-10-31T15:18:21.220Z";
const OLDER_CHECK_AT = "2026-10-31T15:17:30.000Z";
const EDGE_READ_AT = "2026-10-31T15:18:27.000Z";
const LANDED_AT = "2026-10-31T15:18:51.000Z";
const ALL = ["chrome", "edge", "firefox", "safari"];

type Row = Record<string, unknown>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function record(store: string, readAt: string): Row {
  return {
    id: `sub_${store}`,
    store,
    channel: "stable",
    version: "e679664",
    buildId: "e679664",
    status: "submitted",
    storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo" },
    statusRead: { word: "submitted", readAt, source: "poll", storeWord: "PENDING_REVIEW" },
    submittedAt: "2026-10-29T20:24:39Z",
    updatedAt: readAt,
    storeReview: { state: "PENDING_REVIEW", checkedAt: readAt, source: "poll" },
    run: null,
  };
}

const STORE_CONFIG = Object.fromEntries(
  ALL.map((store) => [store, { enabled: true, configured: true, credentialsConfigured: true, credentialsVerified: true, missingSecrets: [] }]),
);

interface Served {
  readAt?: Record<string, string>;
  laterPolls?: (store: string) => Response;
}

const EDGE_READ_NOW = {
  ok: true,
  dispatched: false,
  queued: false,
  store: "edge",
  message: `Edge Add-ons was read now; the mirror's store check started at ${DISPATCHED_AT} and its answer lands within a minute or two.`,
  storeRead: { state: "live", version: "0.2.0", manifestVersion: "0.2.0.7", checkedAt: EDGE_READ_AT },
};

function recentCheck(lastPollAt: string): Response {
  return jsonResponse(
    {
      message: `A store check for this project started at ${lastPollAt}; its answer lands within a minute or two. Read the page before asking again.`,
      code: "STORE_POLL_RECENT",
      retryAfterSeconds: 90,
      lastPollAt,
    },
    429,
  );
}

function serve(served: Served): { fetch: typeof fetch; posts: string[] } {
  const posts: string[] = [];
  const laterPolls = served.laterPolls ?? (() => recentCheck(DISPATCHED_AT));
  const readAt = (store: string) => served.readAt?.[store] ?? LANDED_AT;

  const stub = (async (url: string, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    const poll = /\/stores\/(\w+)\/poll$/.exec(pathname);

    if (poll && init?.method === "POST") {
      const store = poll[1];
      posts.push(store);
      if (posts.length === 1) return jsonResponse({ ok: true, dispatched: true, queued: false, dispatchedAt: DISPATCHED_AT, store });
      if (store === "edge") return jsonResponse(EDGE_READ_NOW);

      return laterPolls(store);
    }

    if (pathname === "/api/cli/whoami") return jsonResponse({ login: "cezaraugusto/rebeccat", live: true, projectId: PROJECT_ID });
    if (pathname === `/api/projects/${PROJECT_ID}/stores/config`) return jsonResponse(STORE_CONFIG);

    const perStore = /\/stores\/(\w+)\/submissions$/.exec(pathname);
    if (perStore) return jsonResponse([record(perStore[1], readAt(perStore[1]))]);

    if (pathname === "/api/cli/stores/submissions") return jsonResponse({ submissions: ALL.map((store) => record(store, readAt(store))) });
    if (pathname.endsWith("/stores/submissions")) return jsonResponse([]);

    if (pathname.endsWith("/_extension-dev/stores/health.json")) {
      return jsonResponse({ schemaVersion: 1, updatedAt: BEFORE, stores: Object.fromEntries(ALL.map((store) => [store, { ok: true, message: "ok", checkedAt: BEFORE }])) });
    }

    if (pathname.endsWith("/_extension-dev/stores/status.json")) {
      return jsonResponse({ schemaVersion: 3, kind: "stores_status", updatedAt: BEFORE, lastPoll: { timestamp: BEFORE, perStore: {}, lanes: {}, updates: [] }, reviews: {} });
    }

    return jsonResponse({ message: "not found" }, 404);
  }) as unknown as typeof fetch;

  return { fetch: stub, posts };
}

const CALL = { project: "cezaraugusto/rebeccat", api: API, refresh: ALL, waitSeconds: 0 };

describe("extension_release_status refresh with several stores: one project-level store check, answered once", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-refresh-shared-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "cezaraugusto",
      projectSlug: "rebeccat",
      projectId: PROJECT_ID,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("answers the first store dispatched with sharedWith, the 429s and Edge's read-now as covered by it, and waits on all four", async () => {
    if (process.platform === "win32") return;

    const served = serve({});

    global.fetch = served.fetch;

    const out = JSON.parse(await readStores(CALL));

    expect(served.posts).toEqual(ALL);
    expect(out.value.refresh.chrome).toEqual({ dispatched: true, queued: false, dispatchedAt: DISPATCHED_AT, sharedWith: ["edge", "firefox", "safari"] });
    expect(out.value.refresh.firefox).toEqual({ covered: true, by: "chrome", dispatchedAt: DISPATCHED_AT });
    expect(out.value.refresh.safari).toEqual({ covered: true, by: "chrome", dispatchedAt: DISPATCHED_AT });
    expect(out.value.refresh.edge).toEqual({
      covered: true,
      by: "chrome",
      dispatchedAt: DISPATCHED_AT,
      message: EDGE_READ_NOW.message,
      storeRead: { state: "live", version: "0.2.0", manifestVersion: "0.2.0.7", checkedAt: EDGE_READ_AT },
    });

    expect(out.value.refreshWait).toEqual({ landed: true, waitedSeconds: 0, stores: ALL });
    expect(out.hint).toContain("one store check dispatched for chrome, edge, firefox and safari");
    expect(out.hint).toContain("it landed within 0 s of waiting, so this read carries the state the check read for chrome, edge, firefox and safari");
    expect(out.hint).toContain("Edge Add-ons serves version 0.2.0 (0.2.0.7) now");
    expect(out.hint).not.toContain("refused");
    expect(out.hint).not.toContain("429");
  });

  it("applies the wait bound to every covered store: one store read before the check keeps landed false", async () => {
    if (process.platform === "win32") return;

    const served = serve({ readAt: { firefox: BEFORE } });

    global.fetch = served.fetch;

    const out = JSON.parse(await readStores(CALL));

    expect(out.value.refreshWait).toEqual({ landed: false, waitedSeconds: 0, stores: ALL });
    expect(out.value.refresh.firefox).toEqual({ covered: true, by: "chrome", dispatchedAt: DISPATCHED_AT });
    expect(out.hint).toContain("it had not landed after 0 s of waiting");
  });

  it("keeps the refusal words for a 429 naming a check someone else started earlier", async () => {
    if (process.platform === "win32") return;

    const served = serve({ laterPolls: () => recentCheck(OLDER_CHECK_AT) });

    global.fetch = served.fetch;

    const out = JSON.parse(await readStores(CALL));

    expect(out.value.refresh.chrome).toEqual({ dispatched: true, queued: false, dispatchedAt: DISPATCHED_AT, sharedWith: ["edge"] });
    expect(out.value.refresh.firefox).toMatchObject({ dispatched: false, queued: false });
    expect(out.value.refresh.firefox.message).toContain(`answered 429: A store check for this project started at ${OLDER_CHECK_AT}`);
    expect(out.value.refresh.firefox.covered).toBeUndefined();
    expect(out.value.refreshWait).toEqual({ landed: true, waitedSeconds: 0, stores: ["chrome", "edge"] });
    expect(out.hint).toContain("firefox refused:");
    expect(out.hint).toContain("safari refused:");
  });

  it("keeps the refusal words for any other status on a later store", async () => {
    if (process.platform === "win32") return;

    const served = serve({ laterPolls: () => jsonResponse({ message: "The platform could not start the store check: boom.", code: "STORE_POLL_DISPATCH_FAILED" }, 502) });

    global.fetch = served.fetch;

    const out = JSON.parse(await readStores(CALL));

    expect(out.value.refresh.safari).toMatchObject({ dispatched: false, queued: false });
    expect(out.value.refresh.safari.message).toContain("answered 502");
    expect(out.value.refresh.chrome.sharedWith).toEqual(["edge"]);
    expect(out.value.refreshWait.stores).toEqual(["chrome", "edge"]);
  });
});
