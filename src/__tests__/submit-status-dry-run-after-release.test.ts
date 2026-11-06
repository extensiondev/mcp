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
const DRY_AT = "2026-11-06T13:05:00.000Z";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function dryRun(store: string) {
  return {
    id: `sub_${store}_dry`,
    store,
    channel: "stable",
    buildId: "a1b2c3d",
    version: "0.3.0",
    status: "dry_run",
    submittedAt: DRY_AT,
    storeUrl: null,
    run: null,
  };
}

const RELEASES = [
  {
    id: "chrome:0.3.0.9",
    store: "chrome",
    version: "0.3.0.9",
    buildSha: "9f8e7d6",
    state: "live",
    storeWord: "PUBLISHED",
    readAt: READ_AT,
    source: "poll",
    visibility: "public",
    submissionId: "sub_chrome_live",
    submittedAt: "2026-11-04T10:00:00.000Z",
    updatedAt: READ_AT,
  },
  {
    id: "safari:0.3.0",
    store: "safari",
    version: "0.3.0",
    buildSha: "a1b2c3d",
    state: "in-review",
    storeWord: "WAITING_FOR_REVIEW",
    readAt: READ_AT,
    source: "poll",
    storeVersion: { packaged: "0.3.0", displayed: "0.3.0", source: "repo", buildNumber: 21 },
    submissionId: "sub_safari_review",
    submittedAt: "2026-11-05T18:00:00.000Z",
    updatedAt: READ_AT,
  },
];

function serve(): typeof fetch {
  return (async (url: string) => {
    const at = String(url);

    if (at.endsWith("stores/health.json")) {
      return jsonResponse({ updatedAt: READ_AT, stores: { chrome: { ok: true, checkedAt: READ_AT }, safari: { ok: true, checkedAt: READ_AT } } });
    }

    if (at.endsWith("/api/cli/stores/submissions")) return jsonResponse({ ok: true, projectId: "prj_1", submissions: [dryRun("chrome"), dryRun("safari")] });
    if (at.endsWith("/api/cli/whoami")) return jsonResponse({ login: "cezaraugusto/rebeccat", projectId: "prj_1", workspaceSlug: "cezaraugusto", projectSlug: "rebeccat" });
    if (at.endsWith("/api/projects/prj_1/releases")) return jsonResponse({ storeReleases: RELEASES });

    return jsonResponse({ message: "not found" }, false, 404);
  }) as unknown as typeof fetch;
}

describe("extension_submit action status leads with the store's word, never a dry run (ledger 442)", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-status-dry-run-"));
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

  it("answers the live Chrome release and the Safari version in review, with the newer dry run after each", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve();
    const out = JSON.parse(await submit({ action: "status", browsers: ["chrome", "safari"], project: "cezaraugusto/rebeccat" }));

    expect(out.status).toBe("status-read");
    expect(out.value.stores[0]).toMatchObject({
      store: "chrome",
      submissionId: "sub_chrome_live",
      version: "0.3.0.9",
      status: "live",
      state: "PUBLISHED",
      readAt: READ_AT,
      source: "poll",
      newerDryRun: { submissionId: "sub_chrome_dry", version: "0.3.0", submittedAt: DRY_AT },
    });

    expect(out.value.stores[1]).toMatchObject({
      store: "safari",
      version: "0.3.0",
      buildNumber: 21,
      status: "in-review",
      state: "WAITING_FOR_REVIEW",
      newerDryRun: { submissionId: "sub_safari_dry" },
    });

    expect(out.hint).toContain(`chrome 0.3.0.9: live, the store says PUBLISHED (poll at ${READ_AT}); a newer dry run of 0.3.0 at ${DRY_AT} sent nothing to the store`);
    expect(out.hint).toContain("safari 0.3.0 build 21: in-review, the store says WAITING_FOR_REVIEW");
    expect(out.hint).not.toContain(": dry_run");
  });
});
