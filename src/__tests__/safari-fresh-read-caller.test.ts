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
import { SAFARI_FRESH_READ_CALL, readStores, safariFreshReadCall, safariNextStep } from "../tools/store-status";
import { storeVersionStatus } from "../tools/store-version-status";

import type { SubmissionView } from "../lib/store-row-sources";

const API = "https://www.extension.dev";
const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];
const READ_AT = "2026-10-31T11:15:45.000Z";
const STATUS_CALL = 'extension_submit {action: "status", browsers: ["safari"], waitSeconds: 180}';

const IN_REVIEW = {
  id: "sub_safari_14",
  store: "safari",
  channel: "stable",
  buildId: "e679664",
  version: "0.2.0",
  status: "submitted",
  submittedAt: "2026-10-29T20:24:00.000Z",
  storeUrl: null,
  run: null,
  storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo", buildNumber: 14 },
  storeReview: { state: "WAITING_FOR_REVIEW", checkedAt: READ_AT, source: "poll" },
  statusRead: { word: "submitted", readAt: READ_AT, source: "poll", storeWord: "WAITING_FOR_REVIEW" },
  appStoreRelease: { type: "MANUAL", readAt: READ_AT },
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const serve = (async (url: string) => {
  const at = String(url);

  if (at.endsWith("/api/cli/whoami")) return jsonResponse({ projectId: "prj_1", workspaceSlug: "acme", projectSlug: "widget" });
  if (at.endsWith("/api/cli/stores/submissions")) return jsonResponse({ ok: true, projectId: "prj_1", submissions: [IN_REVIEW] });

  return jsonResponse({ message: "not found" }, false, 404);
}) as unknown as typeof fetch;

describe("the Safari re-read sentence names the tool that answered (ledger 315)", () => {
  let tmp: string;
  let prevFetch: typeof fetch;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-safari-caller-"));
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_TOKEN;
    delete process.env.EXTENSION_DEV_PROJECT;
    prevFetch = global.fetch;
    global.fetch = serve;
    writeCredentials({ version: 1, token: "claims.sig", workspaceSlug: "acme", projectSlug: "widget", projectId: "prj_1", expiresAt: Math.floor(Date.now() / 1000) + 3600, api: API });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("extension_submit status tells the agent to repeat the status call, not to switch tools", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await storeVersionStatus({ project: "acme/widget", browsers: ["safari"] }));
    const step = out.value.nextStep as { kind: string; say: string };

    expect(out.status).toBe("status-read");
    expect(step.kind).toBe("watch");
    expect(step.say).toContain(`To read Apple's state again in one call, call ${STATUS_CALL}; once it reads PENDING_DEVELOPER_RELEASE`);
    expect(step.say).not.toContain("extension_release_status");
    expect(out.value.stores[0].nextStep.say).toBe(step.say);
    expect(out.hint).toContain(`call ${STATUS_CALL}`);
  });

  it("extension_release_status keeps naming itself", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await readStores({ project: "acme/widget" }));
    const row = out.value.stores.find((entry: { store: string }) => entry.store === "safari");

    expect(row.nextStep.say).toContain(`call ${SAFARI_FRESH_READ_CALL}; once it reads`);
    expect(row.nextStep.say).not.toContain('extension_submit {action: "status"');
  });

  it("the sentence builder takes the caller and the shared step passes it through", () => {
    const view = IN_REVIEW as unknown as SubmissionView;
    const url = "https://console.extension.dev/acme/widget/submissions/safari";

    expect(safariFreshReadCall("extension_submit")).toBe(STATUS_CALL);
    expect(safariFreshReadCall("extension_release_status")).toBe(SAFARI_FRESH_READ_CALL);
    expect(safariNextStep(view, url, "extension_submit")?.say).toContain(STATUS_CALL);
    expect(safariNextStep(view, url)?.say).toContain(SAFARI_FRESH_READ_CALL);
  });
});
