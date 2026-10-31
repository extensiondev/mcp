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
import { toSubmission } from "../lib/platform-submissions";
import { doneStep, PUBLISH_SENTENCE } from "../lib/store-connection";
import { failureLineOf, packageRefusedSentence, storeUploadSentence } from "../lib/store-upload-words";
import { readStores } from "../tools/store-status";
import { storeOutcomes } from "../tools/submit";
import { storeVersionSentence } from "../tools/store-version-status";
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
  it("relays source and message beside the state", () => {
    const row = toSubmission({ id: "sub_edge", store: "edge", status: "failed", storeUpload: upload("FAILED", { message: MESSAGE }) });

    expect(row?.storeUpload).toEqual({ state: "FAILED", checkedAt: CHECKED_AT, source: "poll", message: MESSAGE });
    expect(toSubmission({ store: "edge", storeUpload: upload("SUCCEEDED") })?.storeUpload).toEqual({ state: "SUCCEEDED", checkedAt: CHECKED_AT, source: "poll" });
  });

  it("says each of Microsoft's three operation words in plain words, the refusal in Microsoft's own", () => {
    expect(storeUploadSentence("edge", { state: "InProgress" })).toBe("Edge Add-ons is still processing the package (InProgress)");
    expect(storeUploadSentence("edge", { state: "Succeeded" })).toBe("Edge Add-ons took the package (Succeeded)");
    expect(storeUploadSentence("edge", { state: "Failed", message: MESSAGE })).toBe(REFUSED);
    expect(packageRefusedSentence("edge", { state: "FAILED" })).toBe("Edge Add-ons refused the package (FAILED, no reason given)");
    expect(packageRefusedSentence("edge", { state: "SUCCEEDED" })).toBe("");
    expect(storeUploadSentence("chrome", { state: "FAILURE", message: "Bad manifest" })).toBe("The Chrome Web Store refused the package: Bad manifest");
    expect(failureLineOf("edge", { state: "FAILED", message: MESSAGE }, MESSAGE)).toBe(`edge: ${REFUSED}`);
    expect(failureLineOf("firefox", undefined, "AMO said no")).toBe("firefox: AMO said no");
    expect(failureLineOf("firefox", undefined, "")).toBe("firefox: the store run failed");
  });

  it("grounds the publish step on a taken package and withholds it from a pending one", () => {
    expect(doneStep(["edge"], "", ["edge"]).kind).toBe("publish");
    expect(doneStep(["edge"], "", ["edge"]).say).toContain(PUBLISH_SENTENCE);
    expect(doneStep(["edge"], "").kind).toBe("done");
    expect(doneStep(["chrome"], "").kind).toBe("publish");
  });

  it("answers Microsoft's words in the per-store outcome", () => {
    const byStore = { edge: toSubmission({ id: "sub_edge", store: "edge", ...FAILED })! };
    const out = storeOutcomes({ stores: ["edge"], byStore, ids: { edge: "sub_edge" }, checkedAt: CHECKED_AT, trackUrl: () => "https://console.test/edge" });

    expect(out.edge.storeState).toBe("FAILED");
    expect(out.edge.storeMessage).toBe(MESSAGE);
    expect(out.edge.recorded).toBe(true);
  });

  it("says the refusal in the status sentence and grounds no next step on it", () => {
    const refused = storeVersionSentence(
      { store: "edge", submissionId: "sub_edge", version: "0.2.0.9", buildNumber: null, status: "failed", state: "FAILED", storeMessage: MESSAGE, readAt: CHECKED_AT, source: "poll", releaseType: null, nextStep: null },
      null,
      null,
    );
    const taken = storeVersionSentence(
      { store: "edge", submissionId: "sub_edge", version: "0.2.0.9", buildNumber: null, status: "draft", state: "SUCCEEDED", readAt: CHECKED_AT, source: "poll", releaseType: null, nextStep: null },
      null,
      null,
    );

    expect(refused).toBe(`edge 0.2.0.9: failed, ${REFUSED} (poll at ${CHECKED_AT})`);
    expect(refused).not.toContain("the store says FAILED");
    expect(taken).toBe(`edge 0.2.0.9: draft, the store says SUCCEEDED (poll at ${CHECKED_AT})`);
  });
});

describe("an Edge submit answers the package operation the platform recorded", () => {
  const world = usePlatformWorld("extdev-edge-upload-words-");

  it("says a refused package in Microsoft's words and never offers Send to review", async () => {
    if (process.platform === "win32") return;

    world.login();
    approvedEdgeSubmit(world, FAILED);

    const out = await world.call("extension_submit", { ...ARGS, waitSeconds: 5 });
    const context = JSON.stringify(out).slice(0, 2000);

    expect(out.status, context).toBe("submit-failed");
    expect(out.error.message).toContain(`edge: ${REFUSED}`);
    expect(out.value.outcome.recorded).toBe(true);
    expect(out.value.outcome.status).toBe("failed");
    expect(out.value.outcome.storeState).toBe("FAILED");
    expect(out.value.outcomes.edge.storeMessage).toBe(MESSAGE);
    expect(out.value.nextStep.kind).toBe("resubmit");
    expect(out.value.nextStep.say).toContain(`The store answered: edge: ${REFUSED}`);
    expect(JSON.stringify(out)).not.toContain(PUBLISH_SENTENCE);
    expect(JSON.stringify(out.value.nextStep)).not.toMatch(/recorded as uploaded|say publish/);
  });

  it("never offers Send to review for a draft whose package operation reads Failed", async () => {
    if (process.platform === "win32") return;

    world.login();
    approvedEdgeSubmit(world, { ...FAILED, status: "draft", rawStatus: "draft", failureReason: undefined });

    const out = await world.call("extension_submit", { ...ARGS, waitSeconds: 5 });
    const context = JSON.stringify(out).slice(0, 2000);

    expect(out.status, context).toBe("submit-failed");
    expect(out.value.nextStep.kind).toBe("resubmit");
    expect(out.value.nextStep.say).toContain(`edge: ${REFUSED}`);
    expect(JSON.stringify(out)).not.toContain(PUBLISH_SENTENCE);
  });

  it("grounds the publish step on a Succeeded package like Chrome's", async () => {
    if (process.platform === "win32") return;

    world.login();
    approvedEdgeSubmit(world, SUCCEEDED);

    const out = await world.call("extension_submit", { ...ARGS, waitSeconds: 5 });
    const context = JSON.stringify(out).slice(0, 2000);

    expect(out.status, context).toBe("submitted");
    expect(out.value.outcome.storeState).toBe("SUCCEEDED");
    expect(out.value.outcomes.edge.storeMessage).toBeUndefined();
    expect(out.value.nextStep.kind).toBe("publish");
    expect(out.value.nextStep.say).toContain(PUBLISH_SENTENCE);
    expect(out.hint).toContain("store state SUCCEEDED");
  });

  it("keeps the done sentence while the package operation is still InProgress", async () => {
    if (process.platform === "win32") return;

    world.login();
    approvedEdgeSubmit(world, IN_PROGRESS);

    const out = await world.call("extension_submit", { ...ARGS, waitSeconds: 5 });
    const context = JSON.stringify(out).slice(0, 2000);

    expect(out.status, context).toBe("submitted");
    expect(out.value.outcome.storeState).toBe("InProgress");
    expect(out.value.nextStep.kind).toBe("done");
    expect(JSON.stringify(out)).not.toContain(PUBLISH_SENTENCE);
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

describe("extension_release_status says a refused Edge package in Microsoft's words", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-edge-upload-status-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "widget",
      projectId: "prj_1",
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

  it("carries the upload on the row and says the refusal once in the hint", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve({ id: "sub_edge", store: "edge", channel: "stable", buildId: "a4c0e00", version: "0.2.0.9", submittedAt: "2026-10-29T12:00:00.000Z", run: null, ...FAILED });

    const out = JSON.parse(await readStores({ workspace: "acme", project: "widget" }));
    const edge = out.value.stores.find((row: { store: string }) => row.store === "edge");

    expect(edge.lastSubmission.storeUpload).toEqual({ state: "FAILED", checkedAt: CHECKED_AT, source: "poll", message: MESSAGE });
    expect(out.hint).toContain(`last submission v0.2.0.9 failed (read from a store check at ${CHECKED_AT}, the store says FAILED) at 2026-10-29T12:00:00.000Z: ${REFUSED}`);
    expect(out.hint.split(MESSAGE.slice(0, 40)).length).toBe(2);
  });

  it("says the store took the package for a Succeeded draft", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve({ id: "sub_edge", store: "edge", channel: "stable", buildId: "a4c0e00", version: "0.2.0.9", submittedAt: "2026-10-29T12:00:00.000Z", run: null, ...SUCCEEDED });

    const out = JSON.parse(await readStores({ workspace: "acme", project: "widget" }));
    const edge = out.value.stores.find((row: { store: string }) => row.store === "edge");

    expect(edge.lastSubmission.storeUpload).toEqual({ state: "SUCCEEDED", checkedAt: CHECKED_AT, source: "poll" });
    expect(out.hint).toContain(`last submission v0.2.0.9 draft (read from a store check at ${CHECKED_AT}, the store says SUCCEEDED)`);
    expect(out.hint).not.toContain("refused");
  });
});
