import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { readStores as handler } from "../tools/store-status";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

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
  updatedAt: "2026-10-27T12:00:00.000Z",
  stores: { chrome: { ok: true, message: "Credentials verified.", checkedAt: "2026-10-27T12:00:00.000Z" } },
};

const RECORD = {
  id: "22224c04",
  store: "chrome",
  channel: "stable",
  buildId: "6d9e10c",
  version: "0.2.0",
  status: "withdrawn",
  submittedAt: "2026-10-21T12:00:00.000Z",
  storeUrl: null,
  run: null,
};

const READS = [
  { word: "approved", readAt: "2026-10-30T18:00:00.000Z", source: "poll", state: "PUBLISHED" },
  { word: "withdrawn", readAt: "2026-11-01T09:00:00.000Z", source: "poll", state: "CANCELLED" },
];

describe("extension_release_status carries every store read the platform recorded", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-store-reads-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
    });
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("answers the platform record's reads as stored, newest last", async () => {
    if (process.platform === "win32") return;

    global.fetch = fetchByFile({
      "stores/health.json": HEALTH,
      "/api/cli/stores/submissions": { ok: true, projectId: "prj_1", submissions: [{ ...RECORD, storeReads: READS }] },
    });

    const out = JSON.parse(await handler({ workspace: "acme", project: "widget" }));
    const chrome = out.value.stores.find((row: { store: string }) => row.store === "chrome");

    expect(chrome.lastSubmission.storeReads).toEqual(READS);
  });

  it("never takes reads from the registry document, which the run writes", async () => {
    if (process.platform === "win32") return;

    global.fetch = fetchByFile({
      "stores/health.json": HEALTH,
      "stores/submissions.json": {
        updatedAt: "2026-11-01T09:00:00.000Z",
        submissions: [{ id: "22224c04", store: "chrome", status: "withdrawn", version: "0.2.0", buildId: "6d9e10c", submittedAt: RECORD.submittedAt, storeReads: READS }],
      },
      "/api/cli/stores/submissions": { ok: true, projectId: "prj_1", submissions: [] },
    });

    const out = JSON.parse(await handler({ workspace: "acme", project: "widget" }));
    const chrome = out.value.stores.find((row: { store: string }) => row.store === "chrome");

    expect(chrome.lastSubmission.id).toBe("22224c04");
    expect("storeReads" in chrome.lastSubmission).toBe(false);
    expect(JSON.stringify(out)).not.toContain("storeReads");
  });
});
