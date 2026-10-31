// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { storeReleaseSentence, storeReleaseView } from "../lib/platform-store-releases";
import { releaseBesideSubmission } from "../lib/release-beside-submission";
import { firefoxReleasesByChannel, readStores } from "../tools/store-status";

import type { SubmissionView } from "../lib/store-row-sources";

const POLL_AT = "2026-10-31T14:06:00.000Z";
const PROJECT_ID = "prj_hands_free";

const INFERRED_ROW = storeReleaseView({
  id: "firefox:0.1.0.1",
  store: "firefox",
  version: "0.1.0.1",
  buildSha: "8467b5b",
  state: "in-review",
  storeWord: "",
  readAt: "2026-10-31T14:03:00.000Z",
  source: "inferred",
  visibility: "unlisted",
  amoChannel: "unlisted",
  submissionId: "067667a3",
  submittedAt: "2026-10-31T14:00:00.000Z",
  updatedAt: "2026-10-31T14:03:00.000Z",
})!;

const SIGNED_SUBMISSION: SubmissionView = {
  id: "067667a3",
  version: "0.1.0.1",
  status: "signed",
  buildSha: "8467b5b",
  submittedAt: "2026-10-31T14:00:00.000Z",
  storeVersion: { packaged: "0.1.0.1", displayed: "0.1.0", source: "platform", buildNumber: 1 },
  storeReview: { state: "PUBLIC", checkedAt: POLL_AT, source: "poll", visibility: "unlisted" },
  statusRead: { word: "signed", readAt: POLL_AT, source: "poll", storeWord: "PUBLIC" },
};

describe("a release row the platform inferred takes the same submission's store read", () => {
  it("reads signed with AMO's file status beside an inferred in-review row once the poll read the submission signed", () => {
    const row = releaseBesideSubmission(INFERRED_ROW, SIGNED_SUBMISSION);

    expect(row).toMatchObject({
      state: "signed",
      storeWord: "PUBLIC",
      readAt: POLL_AT,
      source: "poll",
      wordTakenFrom: { was: "in-review", submission: "067667a3" },
    });

    const said = storeReleaseSentence(row);

    expect(said).toBe(`firefox unlisted 0.1.0.1 signed (unlisted, not on AMO) on build 8467b5b (AMO's file status PUBLIC, read ${POLL_AT} by poll)`);
    expect(said).not.toContain("in-review");
    expect(said).not.toContain("inferred");
  });

  it("matches the row by version when the submission id differs, and leaves another version alone", () => {
    expect(releaseBesideSubmission(INFERRED_ROW, { ...SIGNED_SUBMISSION, id: "other" }).state).toBe("signed");
    expect(releaseBesideSubmission({ ...INFERRED_ROW, id: "firefox:0.1.0.2", version: "0.1.0.2", submissionId: "sub_2" }, SIGNED_SUBMISSION)).toMatchObject({
      state: "uploaded",
      source: "inferred",
      wordTakenFrom: { was: "in-review", channel: "unlisted" },
    });
  });

  it("never touches a row the store answered, and takes nothing from a submission word nobody read", () => {
    const read = { ...INFERRED_ROW, source: "poll", storeWord: "AWAITING_REVIEW", amoChannel: "listed", visibility: "public" };

    expect(releaseBesideSubmission(read, SIGNED_SUBMISSION)).toBe(read);

    const inferredSubmission = { ...SIGNED_SUBMISSION, status: "submitted", statusRead: { word: "submitted", source: "inferred" as const } };
    const listed = { ...INFERRED_ROW, amoChannel: "listed", visibility: "public" };

    expect(releaseBesideSubmission(listed, inferredSubmission)).toBe(listed);
    expect(releaseBesideSubmission(listed, undefined)).toBe(listed);
  });

  it("reads an unlisted Firefox row no store answered as uploaded, never in review", () => {
    expect(releaseBesideSubmission(INFERRED_ROW, undefined)).toMatchObject({ state: "uploaded", source: "inferred", wordTakenFrom: { was: "in-review", channel: "unlisted" } });
    expect(storeReleaseSentence(releaseBesideSubmission(INFERRED_ROW, undefined))).toContain("firefox unlisted 0.1.0.1 uploaded on build 8467b5b (inferred");
  });

  it("applies the read to the unlisted lane and keeps the listed lane's own review", () => {
    const listed = storeReleaseView({
      ...INFERRED_ROW,
      id: "firefox:0.1.0.2",
      version: "0.1.0.2",
      submissionId: "sub_listed",
      storeWord: "AWAITING_REVIEW",
      source: "poll",
      visibility: "listed",
      amoChannel: "listed",
    })!;
    const lanes = firefoxReleasesByChannel([INFERRED_ROW, listed], SIGNED_SUBMISSION);

    expect(lanes?.unlisted).toMatchObject({ state: "signed", source: "poll" });
    expect(lanes?.listed).toMatchObject({ state: "in-review", source: "poll", storeWord: "AWAITING_REVIEW" });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe("extension_release_status never prints an inferred release word beside the submission's store read", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-release-beside-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "cezaraugusto",
      projectSlug: "hands-free",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
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

  it("says the unlisted Firefox release is signed, not on AMO, when the poll read the submission signed and the release row lagged", async () => {
    if (process.platform === "win32") return;

    const routes: Record<string, unknown> = {
      "/api/cli/whoami": { login: "cezaraugusto/hands-free", live: true, projectId: PROJECT_ID },
      [`/api/projects/${PROJECT_ID}/releases`]: {
        items: [],
        storeReleases: [{ ...INFERRED_ROW, wordTakenFrom: undefined }],
        summary: { activeReleases: 0, liveChannels: 0, channels: 0 },
      },
      "/api/cli/stores/submissions": {
        ok: true,
        projectId: PROJECT_ID,
        submissions: [
          {
            id: "067667a3",
            store: "firefox",
            channel: "preview",
            buildId: "8467b5b",
            version: "0.1.0",
            status: "signed",
            submittedAt: "2026-10-31T14:00:00.000Z",
            storeVersion: SIGNED_SUBMISSION.storeVersion,
            storeReview: SIGNED_SUBMISSION.storeReview,
            statusRead: SIGNED_SUBMISSION.statusRead,
          },
        ],
      },
    };

    global.fetch = (async (url: string) => {
      const pathname = new URL(String(url)).pathname;
      const hit = Object.keys(routes).find((route) => pathname.endsWith(route));

      return hit ? jsonResponse(routes[hit]) : jsonResponse({ message: "not found" }, 404);
    }) as unknown as typeof fetch;

    const out = JSON.parse(await readStores({ workspace: "cezaraugusto", project: "hands-free" }));
    const firefox = out.value.stores.find((row: { store: string }) => row.store === "firefox");

    expect(firefox.lastSubmission.status).toBe("signed");
    expect(firefox.release).toMatchObject({ state: "signed", storeWord: "PUBLIC", source: "poll", readAt: POLL_AT, wordTakenFrom: { was: "in-review", submission: "067667a3" } });
    expect(firefox.amoChannels.unlisted).toMatchObject({ state: "signed", source: "poll" });
    expect(out.hint).toContain(`release: firefox unlisted 0.1.0.1 signed (unlisted, not on AMO) on build 8467b5b (AMO's file status PUBLIC, read ${POLL_AT} by poll)`);
    expect(out.hint).not.toContain("in-review");
  });
});
