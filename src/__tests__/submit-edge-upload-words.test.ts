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

import { actionFingerprint } from "../lib/approval-gate";
import { writeCredentials } from "../lib/credentials";
import { doneStep, PUBLISH_SENTENCE } from "../lib/store-connection";
import { WORLD_API, usePlatformWorld, type World } from "./fixtures/platform-world";

const SUBMIT = /^POST \/api\/cli\/stores\/submit$/;
const RECORDS = /^GET \/api\/cli\/stores\/submissions$/;
const CHECKED_AT = "2026-10-31T17:02:00.000Z";
const MESSAGE = "Package validation failed: the manifest's version 0.2.0.9 is not higher than the published version 0.2.0.9.";
const REFUSED = `Edge Add-ons refused the package: ${MESSAGE.replace(/[.\s]+$/, "")}`;
const ARGS = {
  action: "submit",
  browsers: ["edge"],
  buildSha: "a4c0e00",
  dryRun: false,
  approvalId: "apr_edge",
  api: WORLD_API,
};

function upload(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { state, checkedAt: CHECKED_AT, source: "poll", ...extra };
}

const FAILED = {
  status: "failed",
  rawStatus: "upload_failed",
  failureReason: MESSAGE,
  statusRead: { word: "failed", readAt: CHECKED_AT, source: "poll", storeWord: "FAILED", note: MESSAGE },
  storeUpload: upload("FAILED", { message: MESSAGE }),
};

const SUCCEEDED = {
  status: "draft",
  statusRead: { word: "draft", readAt: CHECKED_AT, source: "poll", storeWord: "SUCCEEDED" },
  storeUpload: upload("SUCCEEDED"),
};

const IN_PROGRESS = {
  status: "draft",
  statusRead: { word: "draft", readAt: CHECKED_AT, source: "poll", storeWord: "INPROGRESS" },
  storeUpload: upload("InProgress"),
};

function approvedEdgeSubmit(world: World, record: Record<string, unknown>): void {
  world.routes.push([
    /^GET \/api\/cli\/approvals\/apr_edge$/,
    () => ({
      body: {
        status: "approved",
        used: false,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        fingerprint: actionFingerprint("extension_submit", { browsers: ["edge"], buildSha: "a4c0e00" }),
      },
    }),
  ]);

  world.routes.push([
    SUBMIT,
    () => ({
      body: {
        ok: true,
        buildId: "a4c0e00",
        dispatchedAt: "2026-10-31T17:00:00.000Z",
        submissions: [{ id: "sub_edge", store: "edge", status: "pending" }],
      },
    }),
  ]);

  world.routes.push([RECORDS, () => ({ body: { submissions: [{ id: "sub_edge", store: "edge", version: "0.2.0.9", ...record }] } })]);
}

describe("the Edge package operation reaches the record with its source and message", () => {

  it("grounds the publish step on a taken package and withholds it from a pending one", () => {
    expect(doneStep(["edge"], "", ["edge"]).kind).toBe("publish");
    expect(doneStep(["edge"], "", ["edge"]).say).toContain(PUBLISH_SENTENCE);
    expect(doneStep(["edge"], "").kind).toBe("done");
    expect(doneStep(["chrome"], "").kind).toBe("publish");
  });

  it("480: never offers the publish step for a store whose saved mode sends the upload on to review", () => {
    const published = doneStep(["chrome"], "", [], { chrome: "public" });
    const mixed = doneStep(["chrome", "edge"], "", ["edge"], { chrome: "public" });

    expect(published.kind).toBe("done");
    expect(published.say).toContain('under the Chrome Web Store\'s saved mode "public", the same run sent it on to review; no publish approval is needed');
    expect(published.say).toContain("extension_release_status (include: ['stores'])");
    expect(published.say).not.toContain(PUBLISH_SENTENCE);
    expect(mixed.kind).toBe("done");
    expect(mixed.say).toContain("Edge Add-ons holds its upload as a draft, not published and not in review");
    expect(mixed.say).not.toContain(PUBLISH_SENTENCE);
    expect(doneStep(["chrome"], "", [], { chrome: "draft-until-public" }).kind).toBe("publish");
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

function serve(row: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    const at = String(url);

    if (at.endsWith("stores/health.json")) {
      return jsonResponse({ updatedAt: CHECKED_AT, stores: { edge: { ok: true, message: "ok", checkedAt: CHECKED_AT } } });
    }

    if (at.endsWith("/api/cli/stores/submissions")) return jsonResponse({ ok: true, projectId: "prj_1", submissions: [row] });

    return jsonResponse({ message: "not found" }, false, 404);
  }) as unknown as typeof fetch;
}
