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
import { handler as submit } from "../tools/submit";

const READ_AT = "2026-11-06T12:40:00.000Z";
const RELEASED_AT = "2026-11-04T10:00:00.000Z";
const OLDER_DRY_AT = "2026-11-01T10:00:00.000Z";
const NEWER_DRY_AT = "2026-11-06T13:05:00.000Z";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function dryRun(submittedAt: string) {
  return {
    id: "sub_chrome_dry",
    store: "chrome",
    channel: "stable",
    buildId: "a1b2c3d",
    version: "0.3.0",
    status: "dry_run",
    submittedAt,
    storeUrl: null,
    run: null,
  };
}

function liveRelease(submittedAt: string | undefined) {
  return {
    id: "chrome:0.3.0.9",
    store: "chrome",
    version: "0.3.0.9",
    buildSha: "9f8e7d6",
    state: "live",
    storeWord: "PUBLISHED",
    readAt: READ_AT,
    source: "poll",
    visibility: "public",
    submissionId: "",
    ...(submittedAt ? { submittedAt } : {}),
    updatedAt: READ_AT,
  };
}

function serve(submissions: unknown[], storeReleases: unknown[]): typeof fetch {
  return (async (url: string) => {
    const at = String(url);

    if (at.endsWith("stores/health.json")) return jsonResponse({ updatedAt: READ_AT, stores: { chrome: { ok: true, checkedAt: READ_AT } } });
    if (at.endsWith("/api/cli/stores/submissions")) return jsonResponse({ ok: true, projectId: "prj_1", submissions });
    if (at.endsWith("/api/cli/whoami")) return jsonResponse({ login: "cezaraugusto/rebeccat", projectId: "prj_1", workspaceSlug: "cezaraugusto", projectSlug: "rebeccat" });
    if (at.endsWith("/api/projects/prj_1/releases")) return jsonResponse({ storeReleases });

    return jsonResponse({ message: "not found" }, false, 404);
  }) as unknown as typeof fetch;
}

async function chromeStatus(): Promise<{ hint: string; entry: Record<string, unknown> }> {
  const out = JSON.parse(await submit({ action: "status", browsers: ["chrome"], project: "cezaraugusto/rebeccat" }));

  expect(out.status).toBe("status-read");

  return { hint: out.hint, entry: out.value.stores[0] };
}

const LIVE_LINE = `chrome 0.3.0.9: live, the store says PUBLISHED (poll at ${READ_AT})`;

describe("extension_submit action status names a dry run newer only when it is, and leads with a release that has no submission record (ledger 446, 447)", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-status-release-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "cezaraugusto",
      projectSlug: "rebeccat",
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

  it("does not call a dry run older than the release newer, and leads with the release", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve([dryRun(OLDER_DRY_AT)], [liveRelease(RELEASED_AT)]);
    const { hint, entry } = await chromeStatus();

    expect(entry).toMatchObject({ store: "chrome", submissionId: null, version: "0.3.0.9", status: "live", state: "PUBLISHED", readAt: READ_AT, source: "poll" });
    expect(entry).not.toHaveProperty("newerDryRun");
    expect(hint).toContain(LIVE_LINE);
    expect(hint).not.toContain("newer dry run");
    expect(hint).not.toContain(OLDER_DRY_AT);
    expect(hint).not.toContain(": dry_run");
  });

  it("still names a dry run submitted after the release as newer", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve([dryRun(NEWER_DRY_AT)], [liveRelease(RELEASED_AT)]);
    const { hint, entry } = await chromeStatus();

    expect(entry).toMatchObject({ version: "0.3.0.9", status: "live", newerDryRun: { submissionId: "sub_chrome_dry", version: "0.3.0", submittedAt: NEWER_DRY_AT } });
    expect(hint).toContain(`${LIVE_LINE}; a newer dry run of 0.3.0 at ${NEWER_DRY_AT} sent nothing to the store`);
  });

  it("compares against the release's readAt when its row carries no submittedAt", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve([dryRun(NEWER_DRY_AT)], [liveRelease(undefined)]);
    const newer = await chromeStatus();

    expect(newer.entry).toMatchObject({ newerDryRun: { submittedAt: NEWER_DRY_AT } });
    expect(newer.hint).toContain(`a newer dry run of 0.3.0 at ${NEWER_DRY_AT}`);

    global.fetch = serve([dryRun(OLDER_DRY_AT)], [liveRelease(undefined)]);
    const older = await chromeStatus();

    expect(older.entry).not.toHaveProperty("newerDryRun");
    expect(older.hint).toContain(LIVE_LINE);
    expect(older.hint).not.toContain("newer dry run");
  });

  it("leads with a live release when the store has no submission record", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve([], [liveRelease(RELEASED_AT)]);
    const { hint, entry } = await chromeStatus();

    expect(entry).toMatchObject({ store: "chrome", submissionId: null, version: "0.3.0.9", status: "live", state: "PUBLISHED", readAt: READ_AT, source: "poll" });
    expect(entry).not.toHaveProperty("newerDryRun");
    expect(hint).toContain(LIVE_LINE);
    expect(hint).not.toContain("no submission recorded");
  });

  it("says no submission recorded only when the store has neither a record nor a release", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve([], []);
    const { hint, entry } = await chromeStatus();

    expect(entry).toMatchObject({ store: "chrome", submissionId: null, version: null, status: null, state: null, readAt: null, source: null });
    expect(hint).toContain("chrome: no submission recorded");
  });
});
