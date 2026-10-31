import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { releaseChangeOfRow, releaseChangeSentence } from "../lib/release-type-change";
import { safariReleaseSentence } from "../tools/store-status";
import { storeVersionSentence } from "../tools/store-version-status";
import { handler as submit } from "../tools/submit";

const HOLDS = "approval holds it until you release it";
const AT_ONCE = "approval publishes it on the App Store at once, and an approval cannot be taken back from here";
const HOLD = "the review act sets it to manual release before sending it to App Review unless STORE.md states `- Release: after approval` under `## Safari`, and the record names the change in publish.releaseTypeChanged";
const CHANGED = "set from release after approval to manual release by the review act";
const APPLE = "STATE_ERROR.ENTITY_STATE_INVALID: The release type of this version cannot be changed in its current state.";
const REFUSED = `Apple refused to set it to manual release: ${APPLE}`;
const READ_AT = "2026-10-31T11:35:00.000Z";
const STORE_VERSION = { packaged: "0.1.0", displayed: "0.1.0", source: "repo", buildNumber: 7 };

describe("the release type change the review act recorded", () => {
  it("is read from the publish record, the refusal as Apple's object or as the text alone", () => {
    expect(releaseChangeOfRow({ releaseTypeChanged: { from: "after_approval", to: "manual" } })).toEqual({ releaseTypeChanged: { from: "AFTER_APPROVAL", to: "MANUAL" } });
    expect(releaseChangeOfRow({ releaseTypeChangeRefused: { from: "AFTER_APPROVAL", to: "MANUAL", text: APPLE } })).toEqual({
      releaseTypeChangeRefused: { from: "AFTER_APPROVAL", to: "MANUAL", text: APPLE },
    });

    expect(releaseChangeOfRow({ releaseTypeChangeRefused: APPLE })).toEqual({ releaseTypeChangeRefused: { from: "AFTER_APPROVAL", to: "MANUAL", text: APPLE } });
    expect(releaseChangeOfRow({ releaseType: "MANUAL" })).toEqual({});
    expect(releaseChangeOfRow({ releaseTypeChanged: { from: "AFTER_APPROVAL" } })).toEqual({});
    expect(releaseChangeOfRow(null)).toEqual({});
  });

  it("is said as the act's change or as Apple's refusal", () => {
    expect(releaseChangeSentence({ releaseTypeChanged: { from: "AFTER_APPROVAL", to: "MANUAL" } })).toBe(CHANGED);
    expect(releaseChangeSentence({ releaseTypeChangeRefused: { from: "AFTER_APPROVAL", to: "MANUAL", text: APPLE } })).toBe(REFUSED);
    expect(releaseChangeSentence({})).toBe("");
    expect(releaseChangeSentence(undefined)).toBe("");
  });

  it("follows the release mode in the release status words for the newest Safari submission", () => {
    const changed = safariReleaseSentence({ version: "0.1.0", releaseType: "MANUAL", storeVersion: STORE_VERSION, releaseTypeChanged: { from: "AFTER_APPROVAL", to: "MANUAL" } });

    expect(changed).toBe(`0.1.0 is set to manual release: ${HOLDS}; ${CHANGED}`);

    const refused = safariReleaseSentence({
      version: "0.1.0",
      releaseType: "AFTER_APPROVAL",
      storeVersion: STORE_VERSION,
      releaseTypeChangeRefused: { from: "AFTER_APPROVAL", to: "MANUAL", text: APPLE },
    });

    expect(refused).toBe(`0.1.0 is set to release automatically after approval: ${AT_ONCE}; ${HOLD}; ${REFUSED}`);
    expect(safariReleaseSentence({ version: "0.1.0", releaseType: "MANUAL", storeVersion: STORE_VERSION })).toBe(`0.1.0 is set to manual release: ${HOLDS}`);
  });

  it("follows the release type in the status row sentence", () => {
    const row = {
      store: "safari",
      submissionId: "sub_safari_7",
      version: "0.1.0",
      buildNumber: 7,
      status: "in-review",
      state: "WAITING_FOR_REVIEW",
      readAt: READ_AT,
      source: "poll",
      releaseType: "MANUAL",
      nextStep: null,
    };

    expect(storeVersionSentence({ ...row, releaseTypeChanged: { from: "AFTER_APPROVAL", to: "MANUAL" } }, null, null)).toBe(
      `safari 0.1.0 build 7: in-review, the store says WAITING_FOR_REVIEW (poll at ${READ_AT}), release type MANUAL (${HOLDS}), ${CHANGED}`,
    );

    expect(storeVersionSentence({ ...row, releaseType: "AFTER_APPROVAL", releaseTypeChangeRefused: { from: "AFTER_APPROVAL", to: "MANUAL", text: APPLE } }, null, null)).toContain(
      `release type AFTER_APPROVAL (${AT_ONCE}; ${HOLD}), ${REFUSED}`,
    );

    expect(storeVersionSentence(row, null, null)).toBe(`safari 0.1.0 build 7: in-review, the store says WAITING_FOR_REVIEW (poll at ${READ_AT}), release type MANUAL (${HOLDS})`);
  });
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const LEON = {
  id: "sub_safari_7",
  store: "safari",
  channel: "stable",
  buildId: "63f0d41",
  version: "0.1.0",
  status: "in-review",
  submittedAt: "2026-10-31T10:00:00.000Z",
  storeUrl: null,
  run: null,
  storeVersion: STORE_VERSION,
  storeReview: { state: "WAITING_FOR_REVIEW", checkedAt: READ_AT, source: "poll" },
  statusRead: { word: "in-review", readAt: READ_AT, source: "poll", storeWord: "WAITING_FOR_REVIEW" },
};

describe("extension_submit action status says the release type change the review act recorded", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;
  let submissions: unknown[] = [];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-release-type-change-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "leon",
      projectId: "prj_1",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
    });

    global.fetch = (async (url: string) => {
      const at = String(url);

      if (at.endsWith("stores/health.json")) {
        return jsonResponse({ updatedAt: READ_AT, stores: { safari: { ok: true, message: "ok", checkedAt: READ_AT } } });
      }

      if (at.endsWith("/api/cli/stores/submissions")) return jsonResponse({ ok: true, projectId: "prj_1", submissions });

      return jsonResponse({ message: "not found" }, false, 404);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("carries publish.releaseTypeChanged on the row and says it after the release type", async () => {
    if (process.platform === "win32") return;

    submissions = [
      {
        ...LEON,
        appStoreRelease: { type: "MANUAL", readAt: READ_AT },
        publish: { act: "publish", status: "in-review", at: READ_AT, releaseType: "MANUAL", releaseTypeChanged: { from: "AFTER_APPROVAL", to: "MANUAL" } },
      },
    ];

    const out = JSON.parse(await submit({ action: "status", browsers: ["safari"], project: "acme/leon" }));

    expect(out.ok).toBe(true);
    expect(out.value.stores[0]).toMatchObject({ releaseType: "MANUAL", releaseTypeChanged: { from: "AFTER_APPROVAL", to: "MANUAL" } });
    expect(out.value.stores[0].releaseTypeChangeRefused).toBeUndefined();
    expect(out.hint).toContain(`release type MANUAL (${HOLDS}), ${CHANGED}`);
  });

  it("carries Apple's refusal of the hold, recorded as the text alone, and says it in Apple's words", async () => {
    if (process.platform === "win32") return;

    submissions = [
      {
        ...LEON,
        appStoreRelease: { type: "AFTER_APPROVAL", readAt: READ_AT },
        publish: { act: "publish", status: "in-review", at: READ_AT, releaseType: "AFTER_APPROVAL", releaseTypeChangeRefused: APPLE },
      },
    ];

    const out = JSON.parse(await submit({ action: "status", browsers: ["safari"], project: "acme/leon" }));

    expect(out.ok).toBe(true);
    expect(out.value.stores[0]).toMatchObject({ releaseType: "AFTER_APPROVAL", releaseTypeChangeRefused: { from: "AFTER_APPROVAL", to: "MANUAL", text: APPLE } });
    expect(out.value.stores[0].releaseTypeChanged).toBeUndefined();
    expect(out.hint).toContain(`release type AFTER_APPROVAL (${AT_ONCE}; ${HOLD}), ${REFUSED}`);
  });
});
