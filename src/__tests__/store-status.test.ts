import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handler,
  latestSubmissionsByStore,
  normalizeStoresStatus,
  schema,
} from "../tools/store-status";
import { tools as ALL_TOOLS } from "../index";
import { writeCredentials } from "../lib/credentials";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Route registry fetches by URL suffix; unrouted files 404. */
function fetchByFile(files: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    for (const [suffix, body] of Object.entries(files)) {
      if (String(url).endsWith(suffix)) return jsonResponse(body);
    }
    return jsonResponse({ message: "not found" }, false, 404);
  }) as unknown as typeof fetch;
}

const HEALTH = {
  schemaVersion: 1,
  updatedAt: "2026-07-22T17:05:43.522Z",
  stores: {
    chrome: {
      ok: true,
      message: "Credentials verified.",
      checkedAt: "2026-07-22T17:05:43.522Z",
    },
    edge: {
      ok: false,
      message: "Unauthorized. The Edge API key may be expired.",
      checkedAt: "2026-07-22T17:05:43.522Z",
    },
    firefox: {
      ok: true,
      message: "Credentials verified.",
      checkedAt: "2026-07-22T17:05:43.522Z",
    },
  },
};

const SUBMISSIONS = {
  updatedAt: "2026-07-22T17:25:05.000Z",
  submissions: [
    {
      id: "sub-old",
      store: "firefox",
      channel: "stable",
      storeSubmissionId: "111",
      version: "1.0.1",
      status: "approved",
      submittedAt: "2026-07-10T00:00:00.000Z",
      storeUrl: "https://addons.mozilla.org/firefox/addon/old",
    },
    {
      id: "sub-new",
      store: "firefox",
      channel: "stable",
      storeSubmissionId: "6369599",
      version: "1.0.2",
      status: "submitted",
      submittedAt: "2026-07-22T17:25:05.000Z",
      buildId: "0c7471e",
      storeUrl: "https://addons.mozilla.org/firefox/addon/probe",
    },
  ],
};

const STATUS_V3 = {
  schemaVersion: 3,
  kind: "stores_status",
  updatedAt: "2026-07-22T18:00:00.000Z",
  lastSubmission: {
    store: "firefox",
    channel: "stable",
    buildSha: "0c7471e",
    version: "1.0.2",
    status: "submitted",
    storeUrl: "https://addons.mozilla.org/firefox/addon/probe",
    storeSubmissionId: "6369599",
    timestamp: "2026-07-22T17:25:08.746Z",
  },
  lastPoll: {
    timestamp: "2026-07-22T18:00:00.000Z",
    perStore: {},
    updates: [],
  },
  reviews: {
    firefox: {
      buildId: "0c7471e",
      version: "1.0.2",
      status: "pending",
      checkedAt: "2026-07-22T18:00:00.000Z",
    },
  },
};

describe("extension_store_status: registration + schema", () => {
  it("is registered and mirrors release_list's project override contract", () => {
    expect(schema.name).toBe("extension_store_status");
    expect(ALL_TOOLS.map((t) => t.schema.name)).toContain(
      "extension_store_status",
    );
    const props = Object.keys(
      (schema.inputSchema as { properties: Record<string, unknown> })
        .properties,
    );
    expect(props.sort()).toEqual(["project", "workspace"]);
    expect((schema.inputSchema as { required: string[] }).required).toEqual([]);
  });

  it("describes itself as read-only and names its registry sources", () => {
    expect(schema.description).toContain("read-only");
    expect(schema.description).toContain("stores/health.json");
    expect(schema.description).toContain("stores/status.json");
    expect(schema.description).toContain("stores/submissions.json");
  });
});

describe("extension_store_status handler", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-store-status-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp; // no stored login by default
    prevFetch = global.fetch;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("fails without a project, naming extension_login and the overrides", async () => {
    if (process.platform === "win32") return; // credentials path uses APPDATA
    const out = JSON.parse(await handler({}));
    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("StoreStatusInputError");
    expect(out.error.message).toContain("extension_login");
    expect(out.error.message).toContain("workspace + project");
  });

  it("reports per-store configured, health, last submission, and review", async () => {
    global.fetch = fetchByFile({
      "stores/health.json": HEALTH,
      "stores/status.json": STATUS_V3,
      "stores/submissions.json": SUBMISSIONS,
    });

    const out = JSON.parse(
      await handler({ workspace: "acme", project: "widget" }),
    );

    expect(out.ok).toBe(true);
    expect(out.workspace).toBe("acme");
    expect(out.project).toBe("widget");

    const byStore = Object.fromEntries(
      out.stores.map((r: { store: string }) => [r.store, r]),
    );

    // Healthy configured store, nothing submitted.
    expect(byStore.chrome.configured).toBe(true);
    expect(byStore.chrome.health.ok).toBe(true);
    expect(byStore.chrome.lastSubmission).toBeUndefined();

    // Configured store with a FAILING credential stays configured:true (the
    // remedy is rotating the credential, not configuring the store).
    expect(byStore.edge.configured).toBe(true);
    expect(byStore.edge.health.ok).toBe(false);
    expect(byStore.edge.health.message).toContain("Unauthorized");

    // Safari is not a submission lane yet (it ships dark behind the
    // platform's internal flag), so the report must not advertise it.
    expect(byStore.safari).toBeUndefined();

    // Latest submission wins (not the older approved one), with the fields
    // the task contract names: version/status/storeUrl/submittedAt.
    expect(byStore.firefox.lastSubmission.version).toBe("1.0.2");
    expect(byStore.firefox.lastSubmission.status).toBe("submitted");
    expect(byStore.firefox.lastSubmission.storeUrl).toBe(
      "https://addons.mozilla.org/firefox/addon/probe",
    );
    expect(byStore.firefox.lastSubmission.submittedAt).toBe(
      "2026-07-22T17:25:05.000Z",
    );
    expect(byStore.firefox.review.status).toBe("pending");

    expect(out.lastPollAt).toBe("2026-07-22T18:00:00.000Z");
    expect(out.consoleStoresUrl).toContain("/acme/widget/stores");
    expect(out.registryUrls.status).toContain(
      "/acme/widget/_extension-dev/stores/status.json",
    );
    // The summary names the failing store's remedy and the unconfigured
    // store's deep console route.
    expect(out.message).toContain("FAILED the last health check");
    expect(out.message).toContain("/stores/edge");
  });

  it("reports a known store missing from the registry as not configured", async () => {
    global.fetch = fetchByFile({
      "stores/health.json": {
        schemaVersion: 1,
        updatedAt: "2026-07-22T17:05:43.522Z",
        stores: { chrome: HEALTH.stores.chrome },
      },
    });

    const out = JSON.parse(
      await handler({ workspace: "acme", project: "widget" }),
    );

    expect(out.ok).toBe(true);
    const byStore = Object.fromEntries(
      out.stores.map((r: { store: string }) => [r.store, r]),
    );
    expect(byStore.firefox.configured).toBe(false);
    expect(byStore.edge.configured).toBe(false);
    expect(out.message).toContain("/stores/new");
  });

  it("backfills a store's submission from status.json when submissions.json is absent", async () => {
    global.fetch = fetchByFile({
      "stores/health.json": HEALTH,
      "stores/status.json": STATUS_V3,
    });

    const out = JSON.parse(
      await handler({ workspace: "acme", project: "widget" }),
    );
    const firefox = out.stores.find(
      (r: { store: string }) => r.store === "firefox",
    );
    expect(firefox.lastSubmission.version).toBe("1.0.2");
    expect(firefox.lastSubmission.submittedAt).toBe("2026-07-22T17:25:08.746Z");
    // A 404 on the optional submissions.json is normal, not a degradation.
    expect(out.submissionsUnavailable).toBeUndefined();
  });

  it("normalizes a legacy v2 poller document into reviews", async () => {
    const legacy = {
      schemaVersion: 2,
      kind: "store_status",
      updatedAt: "2026-07-01T00:00:00.000Z",
      perStore: { chrome: { checked: 1 } },
      updates: [
        {
          store: "chrome",
          buildId: "abc1234",
          version: "1.0.0",
          status: "approved",
        },
      ],
    };
    global.fetch = fetchByFile({
      "stores/health.json": HEALTH,
      "stores/status.json": legacy,
    });

    const out = JSON.parse(
      await handler({ workspace: "acme", project: "widget" }),
    );
    const chrome = out.stores.find(
      (r: { store: string }) => r.store === "chrome",
    );
    expect(chrome.review.status).toBe("approved");
    expect(chrome.review.checkedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(out.lastPollAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("degrades to configured unknown when only submissions are readable", async () => {
    global.fetch = fetchByFile({
      "stores/submissions.json": SUBMISSIONS,
    });

    const out = JSON.parse(
      await handler({ workspace: "acme", project: "widget" }),
    );
    expect(out.ok).toBe(true);
    const firefox = out.stores.find(
      (r: { store: string }) => r.store === "firefox",
    );
    expect(firefox.configured).toBe("unknown");
    expect(firefox.lastSubmission.version).toBe("1.0.2");
    expect(out.healthUnavailable).toContain("health.json");
  });

  it("fails with a console pointer when the registry has no store data at all", async () => {
    global.fetch = fetchByFile({});
    const out = JSON.parse(
      await handler({ workspace: "acme", project: "widget" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("StoreStatusNotFound");
    expect(out.error.message).toContain("stores/new");
    expect(out.consoleStoresUrl).toContain("/acme/widget/stores");
  });

  it("defaults to the stored login's project", async () => {
    if (process.platform === "win32") return;
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "stored-ws",
      projectSlug: "stored-proj",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
    });
    const seen: string[] = [];
    global.fetch = (async (url: string) => {
      seen.push(String(url));
      return jsonResponse({ message: "not found" }, false, 404);
    }) as unknown as typeof fetch;

    await handler({});
    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) {
      expect(url).toContain("/stored-ws/stored-proj/_extension-dev/stores/");
    }
  });
});

describe("store-status normalizers", () => {
  it("latestSubmissionsByStore keeps the newest record per store", () => {
    const latest = latestSubmissionsByStore(SUBMISSIONS);
    expect(Object.keys(latest)).toEqual(["firefox"]);
    expect(latest.firefox.storeSubmissionId).toBe("6369599");
    expect(latest.firefox.buildSha).toBe("0c7471e");
  });

  it("normalizeStoresStatus tolerates junk", () => {
    expect(normalizeStoresStatus(null).reviews).toEqual({});
    expect(normalizeStoresStatus("nope").reviews).toEqual({});
    expect(normalizeStoresStatus([1, 2]).reviews).toEqual({});
  });

  it("v3 reviews win over legacy updates for the same store", () => {
    const doc = normalizeStoresStatus(STATUS_V3);
    expect(doc.reviews.firefox.status).toBe("pending");
    expect(doc.lastSubmission?.store).toBe("firefox");
    expect(doc.lastPollAt).toBe("2026-07-22T18:00:00.000Z");
  });
});
