import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { readStores } from "../tools/store-status";
import { handler as submit } from "../tools/submit";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_rebeccat";
const BEFORE = "2026-10-31T01:01:29.054Z";
const DISPATCHED_AT = "2026-10-31T01:15:40.387Z";
const POLL_AT = "2026-10-31T01:16:10.000Z";
const LANDED_AT = "2026-10-31T01:16:24.000Z";

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

function safariRecord(readAt: string, source: string): Row {
  return {
    id: "b40be3ae",
    store: "safari",
    channel: "stable",
    version: "e679664",
    buildId: "e679664",
    status: "submitted",
    storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo", buildNumber: 14 },
    storeUrl: "https://apps.apple.com/app/id6826223107",
    statusRead: { word: "submitted", readAt, source, storeWord: "WAITING_FOR_REVIEW" },
    submittedAt: "2026-10-29T20:24:39Z",
    updatedAt: readAt,
    storeReview: { state: "WAITING_FOR_REVIEW", checkedAt: readAt, source },
    publish: { act: "publish", status: "in-review", at: "2026-10-29T20:24:39Z", releaseType: "MANUAL" },
    run: null,
  };
}

const STORE_CONFIG = {
  chrome: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] },
  firefox: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] },
  edge: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] },
  safari: { enabled: true, configured: true, credentialsConfigured: true, credentialsVerified: true, missingSecrets: [] },
};

interface Served {
  rowReadAt?: (reads: number) => string;
  source?: string;
  pollAt?: (reads: number) => string;
  lane?: Row | null;
}

const RAN_UNCHANGED = { ran: true, checked: 1, updated: 0, errors: 0 };

function serve(served: Served): typeof fetch {
  let reads = 0;
  const rowReadAt: (reads: number) => string = served.rowReadAt ?? (() => BEFORE);
  const pollAt: (reads: number) => string = served.pollAt ?? (() => BEFORE);
  const lane = served.lane === undefined ? RAN_UNCHANGED : served.lane;

  return (async (url: string, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;

    if (pathname === `/api/projects/${PROJECT_ID}/stores/safari/poll` && init?.method === "POST") {
      return jsonResponse({ ok: true, dispatched: true, queued: false, dispatchedAt: DISPATCHED_AT, store: "safari" });
    }

    if (pathname === "/api/cli/whoami") return jsonResponse({ login: "cezaraugusto/rebeccat", live: true, projectId: PROJECT_ID });
    if (pathname === `/api/projects/${PROJECT_ID}/stores/config`) return jsonResponse(STORE_CONFIG);
    if (pathname === `/api/projects/${PROJECT_ID}/stores/safari/submissions`) return jsonResponse([safariRecord(rowReadAt(reads), served.source ?? "poll")]);

    if (pathname === "/api/cli/stores/submissions") {
      reads += 1;

      return jsonResponse({ submissions: [safariRecord(rowReadAt(reads), served.source ?? "poll")] });
    }

    if (pathname.endsWith("/stores/submissions")) return jsonResponse([]);

    if (pathname.endsWith("/_extension-dev/stores/health.json")) {
      return jsonResponse({ schemaVersion: 1, updatedAt: BEFORE, stores: { safari: { ok: true, message: "ok", checkedAt: BEFORE } } });
    }

    if (pathname.endsWith("/_extension-dev/stores/status.json")) {
      const at = pollAt(reads);

      return jsonResponse({
        schemaVersion: 3,
        kind: "stores_status",
        updatedAt: at,
        lastPoll: { timestamp: at, perStore: {}, lanes: lane ? { safari: lane } : {}, updates: [] },
        reviews: {},
      });
    }

    return jsonResponse({ message: "not found" }, 404);
  }) as unknown as typeof fetch;
}

const STATUS_CALL: Parameters<typeof submit>[0] = { action: "status", browsers: ["safari"], project: "cezaraugusto/rebeccat", api: API };

describe("extension_submit status: landed means a read at or after the dispatch, and a poll run that read the same state stamps the row", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-poll-run-read-"));
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

  it("moves the row's readAt to the poll run that landed and read the same state, and answers landed", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve({ pollAt: (reads) => (reads >= 1 ? POLL_AT : BEFORE) });

    const out = JSON.parse(await submit({ ...STATUS_CALL, waitSeconds: 180 }));

    expect(out.value.refreshWait).toEqual({ landed: true, waitedSeconds: 10, stores: ["safari"] });
    expect(out.value.stores[0]).toMatchObject({ readAt: POLL_AT, source: "poll", state: "WAITING_FOR_REVIEW", nextStep: expect.objectContaining({ kind: "watch" }) });
    expect(out.value.stores[0].nextStep.say).toContain(`read at ${POLL_AT}`);
    expect(out.hint).toContain("landed within 10 s, so these are the states it read");
    expect(out.hint).toContain(`(poll at ${POLL_AT})`);
    expect(out.hint).not.toContain(BEFORE);
  });

  it("stamps both the status read and the store review on the full store read", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve({ pollAt: () => POLL_AT });

    const out = JSON.parse(await readStores({ project: "cezaraugusto/rebeccat", api: API, refresh: ["safari"], waitSeconds: 60 }));
    const row = out.value.stores.find((entry: Row) => entry.store === "safari");

    expect(out.value.refreshWait).toEqual({ landed: true, waitedSeconds: 0, stores: ["safari"] });
    expect(row.lastSubmission.statusRead.readAt).toBe(POLL_AT);
    expect(row.lastSubmission.storeReview.checkedAt).toBe(POLL_AT);
    expect(row.nextStep.say).toContain(`read at ${POLL_AT}`);
  });

  it.each<[string, Served]>([
    ["the store check never ran after the dispatch", {}],
    ["the row's word came from the publish answer, not a poll", { source: "publish-answer", pollAt: () => POLL_AT }],
    ["the safari lane did not run", { pollAt: () => POLL_AT, lane: { ran: false, reason: "no App Store Connect key on this mirror" } }],
    ["the safari lane checked no record", { pollAt: () => POLL_AT, lane: { ran: true, checked: 0, updated: 0 } }],
    ["the status document has no lanes", { pollAt: () => POLL_AT, lane: null }],
  ])("answers landed: false and names the older read when %s", async (_label, served) => {
    if (process.platform === "win32") return;

    global.fetch = serve(served);

    const out = JSON.parse(await submit({ ...STATUS_CALL, waitSeconds: 30 }));

    expect(out.value.refreshWait).toEqual({ landed: false, waitedSeconds: 30, stores: ["safari"] });
    expect(out.value.stores[0]).toMatchObject({ readAt: BEFORE, nextStep: expect.objectContaining({ kind: "watch" }) });
    expect(out.value.nextStep.kind).toBe("watch");
    expect(out.hint).toContain(
      `had not landed after 30 s, so these are the states before it (safari was read at ${BEFORE}, before the dispatch at ${DISPATCHED_AT}).`,
    );

    expect(out.hint).not.toContain("these are the states it read");
  });

  it("answers landed as soon as the row carries a read at or after the dispatch, with no poll lane at all", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve({ rowReadAt: (reads) => (reads >= 3 ? LANDED_AT : BEFORE), lane: null });

    const out = JSON.parse(await submit({ ...STATUS_CALL, waitSeconds: 180 }));

    expect(out.value.refreshWait).toEqual({ landed: true, waitedSeconds: 20, stores: ["safari"] });
    expect(out.value.stores[0]).toMatchObject({ readAt: LANDED_AT, source: "poll" });
    expect(out.hint).toContain("landed within 20 s, so these are the states it read");
  });
});
