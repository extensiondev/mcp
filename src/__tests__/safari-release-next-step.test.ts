import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { SAFARI_FRESH_READ_CALL, SAFARI_RELEASE_CALL, readStores } from "../tools/store-status";
import { handler as releaseStatus } from "../tools/release-status";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const OLD_READ = "2026-10-30T16:14:31.000Z";
const DISPATCHED = "2026-10-30T16:26:00.000Z";
const NEW_READ = "2026-10-30T16:27:23.000Z";

const HEALTH = {
  schemaVersion: 1,
  updatedAt: OLD_READ,
  stores: { safari: { ok: true, message: "Credentials verified.", checkedAt: OLD_READ } },
};

function record(word: string, storeWord: string, readAt: string, source = "poll") {
  return {
    id: "sub_safari_14",
    store: "safari",
    channel: "stable",
    buildId: "e679664",
    version: "0.2.0",
    status: word,
    submittedAt: "2026-10-29T20:24:00.000Z",
    storeUrl: null,
    run: null,
    storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo", buildNumber: 14 },
    storeReview: { state: storeWord, checkedAt: readAt, source },
    statusRead: { word, readAt, source, storeWord },
    appStoreRelease: { type: "MANUAL", readAt },
  };
}

const IN_REVIEW = record("submitted", "WAITING_FOR_REVIEW", OLD_READ);
const APPROVED = record("approved", "PENDING_DEVELOPER_RELEASE", NEW_READ);

function serve(answer: () => unknown, polls: string[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const at = String(url);

    if (at.endsWith("/api/projects/prj_1/stores/safari/poll")) {
      polls.push(String(init?.method || "GET"));

      return jsonResponse({ ok: true, dispatched: true, queued: false, dispatchedAt: DISPATCHED, store: "safari" });
    }

    if (at.endsWith("/api/cli/whoami")) return jsonResponse({ projectId: "prj_1", workspaceSlug: "acme", projectSlug: "widget" });
    if (at.endsWith("stores/health.json")) return jsonResponse(HEALTH);
    if (at.endsWith("/api/cli/stores/submissions")) return jsonResponse({ ok: true, projectId: "prj_1", submissions: [answer()] });

    return jsonResponse({ message: "not found" }, false, 404);
  }) as unknown as typeof fetch;
}

function safariRow(out: { value: { stores: Array<Record<string, unknown>> } }): Record<string, unknown> {
  return out.value.stores.find((row) => row.store === "safari") ?? {};
}

describe("the Safari store read answers its own next step, and a refresh can wait for Apple's fresh state", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-safari-next-step-"));
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

  it("says to wait for Apple's review while a store check reads the version in review", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve(() => IN_REVIEW);
    const out = JSON.parse(await readStores({ workspace: "acme", project: "widget" }));
    const step = safariRow(out).nextStep as { kind: string; say: string; url: string };

    expect(step.kind).toBe("watch");
    expect(step.say).toContain("Apple holds 0.2.0 (build 14) as WAITING_FOR_REVIEW, read at 2026-10-30T16:14:31.000Z: wait for Apple's review");
    expect(step.say).toContain(SAFARI_FRESH_READ_CALL);
    expect(step.url).toContain("/acme/widget/submissions");
  });

  it("names the release act once a store check reads PENDING_DEVELOPER_RELEASE", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve(() => APPROVED);
    const step = safariRow(JSON.parse(await readStores({ workspace: "acme", project: "widget" }))).nextStep as { kind: string; say: string };

    expect(step.kind).toBe("release");
    expect(step.say).toContain(`call ${SAFARI_RELEASE_CALL}`);
    expect(step.say).toContain("read at 2026-10-30T16:27:23.000Z");
  });

  it.each([
    ["inferred", record("approved", "PENDING_DEVELOPER_RELEASE", NEW_READ, "inferred")],
    ["hand", record("approved", "PENDING_DEVELOPER_RELEASE", NEW_READ, "hand")],
    ["inferred in review", record("submitted", "WAITING_FOR_REVIEW", OLD_READ, "inferred")],
  ])("grounds no next step on a word read by %s", async (_label, row) => {
    if (process.platform === "win32") return;

    global.fetch = serve(() => row);

    expect(safariRow(JSON.parse(await readStores({ workspace: "acme", project: "widget" }))).nextStep).toBeUndefined();
  });

  it("with waitSeconds, answers once the store check lands, in one call", async () => {
    if (process.platform === "win32") return;

    const polls: string[] = [];
    let reads = 0;
    global.fetch = serve(() => {
      reads += 1;

      return reads >= 3 ? APPROVED : IN_REVIEW;
    }, polls);

    const out = JSON.parse(
      await releaseStatus({ include: ["stores"], workspace: "acme", project: "widget", refresh: ["safari"], waitSeconds: 180 }),
    );
    const section = out.value.stores;
    const stores = section.value;

    expect(polls).toEqual(["POST"]);
    expect(stores.refreshWait).toEqual({ landed: true, waitedSeconds: 20, stores: ["safari"] });
    expect(safariRow(section).nextStep).toMatchObject({ kind: "release" });
    expect(section.hint).toContain("it landed within 20 s of waiting");
    expect(section.hint).not.toContain("read extension_release_status again");
  });

  it("with waitSeconds, says the read is the state before the check when the bound passes first", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve(() => IN_REVIEW);

    const out = JSON.parse(await readStores({ workspace: "acme", project: "widget", refresh: ["safari"], waitSeconds: 30 }));

    expect(out.value.refreshWait).toEqual({ landed: false, waitedSeconds: 30, stores: ["safari"] });
    expect(out.hint).toContain("it had not landed after 30 s of waiting, so this read is the state before it");
    expect(safariRow(out).nextStep).toMatchObject({ kind: "watch" });
  });

  it("without waitSeconds, a refresh reads once and says to read again", async () => {
    if (process.platform === "win32") return;

    let reads = 0;
    global.fetch = serve(() => {
      reads += 1;

      return IN_REVIEW;
    });

    const out = JSON.parse(await readStores({ workspace: "acme", project: "widget", refresh: ["safari"] }));

    expect(reads).toBe(1);
    expect(out.value.refreshWait).toBeUndefined();
    expect(out.hint).toContain("read extension_release_status again before saying the state changed, or pass waitSeconds with refresh");
  });
});
