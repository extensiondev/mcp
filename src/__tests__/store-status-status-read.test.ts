import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { readStores as handler, statusReadNote } from "../tools/store-status";

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
  status: "submitted",
  submittedAt: "2026-10-21T12:00:00.000Z",
  storeUrl: null,
  run: null,
};

const INFERRED = { word: "submitted", readAt: "2026-10-21T12:05:00.000Z", source: "inferred" };
const READ = { word: "published", readAt: "2026-10-27T16:51:00.000Z", source: "poll", storeWord: "NO_ACTIVE_SUBMISSION", liveState: "PUBLISHED" };

describe("extension_release_status says where a submission's word was read", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-store-status-read-"));
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

  it("labels a word the platform only inferred as inferred, in the record and in the hint", async () => {
    if (process.platform === "win32") return;

    global.fetch = fetchByFile({
      "stores/health.json": HEALTH,
      "/api/cli/stores/submissions": { ok: true, projectId: "prj_1", submissions: [{ ...RECORD, statusRead: INFERRED }] },
    });

    const out = JSON.parse(await handler({ workspace: "acme", project: "widget" }));
    const chrome = out.value.stores.find((row: { store: string }) => row.store === "chrome");

    expect(chrome.lastSubmission.statusRead).toEqual(INFERRED);
    expect(out.hint).toContain("last submission v0.2.0 submitted (inferred: the platform has no store answer behind this word, so it grounds no next step");
  });

  it("names the read behind a word the store answered, with the store's own word and when it was read", async () => {
    if (process.platform === "win32") return;

    global.fetch = fetchByFile({
      "stores/health.json": HEALTH,
      "/api/cli/stores/submissions": {
        ok: true,
        projectId: "prj_1",
        submissions: [{ ...RECORD, status: "published", statusRead: READ }],
      },
    });

    const out = JSON.parse(await handler({ workspace: "acme", project: "widget" }));
    const chrome = out.value.stores.find((row: { store: string }) => row.store === "chrome");

    expect(chrome.lastSubmission.statusRead).toEqual(READ);
    expect(out.hint).toContain("published (read from a store check at 2026-10-27T16:51:00.000Z, the store says NO_ACTIVE_SUBMISSION)");
    expect(out.hint).not.toContain("inferred");
  });

  it("says nothing about a record that carries no read, and drops a read it cannot place", () => {
    expect(statusReadNote(undefined)).toBe("");
    expect(statusReadNote({ word: "failed", source: "run", readAt: "2026-10-27T16:51:00.000Z" })).toBe(
      " (read from the run at 2026-10-27T16:51:00.000Z)",
    );

    expect(statusReadNote({ word: "submitted", source: "publish-answer", storeWord: "PENDING_REVIEW" })).toBe(
      " (read from the store's answer, the store says PENDING_REVIEW)",
    );
  });
});
