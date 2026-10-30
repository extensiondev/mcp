import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tools } from "../index";
import { writeCredentials } from "../lib/credentials";
import { createToolDispatcher } from "../lib/tool-dispatch";
import { SAFARI_RELEASE_CALL } from "../tools/store-status";
import { SUBMIT_ACTIONS, handler as submit, schema } from "../tools/submit";

import type { ServerOptions } from "../lib/tool-policy";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const READ_AT = "2026-10-30T16:27:23.000Z";
const OPTIONS: ServerOptions = { features: ["local", "platform"], noShip: false };

function record(source: string) {
  return {
    id: "sub_safari_14",
    store: "safari",
    channel: "stable",
    buildId: "e679664",
    version: "0.2.0",
    status: "approved",
    submittedAt: "2026-10-29T20:24:00.000Z",
    storeUrl: null,
    run: null,
    storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo", buildNumber: 14 },
    storeReview: { state: "PENDING_DEVELOPER_RELEASE", checkedAt: READ_AT, source },
    statusRead: { word: "approved", readAt: READ_AT, source, storeWord: "PENDING_DEVELOPER_RELEASE" },
    appStoreRelease: { type: "MANUAL", readAt: READ_AT },
  };
}

function serve(row: unknown): typeof fetch {
  return (async (url: string) => {
    const at = String(url);

    if (at.endsWith("stores/health.json")) {
      return jsonResponse({ updatedAt: READ_AT, stores: { safari: { ok: true, message: "ok", checkedAt: READ_AT } } });
    }

    if (at.endsWith("/api/cli/stores/submissions")) return jsonResponse({ ok: true, projectId: "prj_1", submissions: [row] });

    return jsonResponse({ message: "not found" }, false, 404);
  }) as unknown as typeof fetch;
}

describe("extension_submit action status reads the store's own state for the newest version", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-submit-status-"));
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

  it("answers version, build, Apple's state, readAt, source, release type and the release act", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve(record("poll"));
    const out = JSON.parse(await submit({ action: "status", browsers: ["safari"], project: "acme/widget" }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("status-read");
    expect(out.value.stores).toEqual([
      {
        store: "safari",
        submissionId: "sub_safari_14",
        version: "0.2.0",
        buildNumber: 14,
        status: "approved",
        state: "PENDING_DEVELOPER_RELEASE",
        readAt: READ_AT,
        source: "poll",
        releaseType: "MANUAL",
        nextStep: expect.objectContaining({ kind: "release" }),
      },
    ]);

    expect(out.value.nextStep.kind).toBe("release");
    expect(out.value.nextStep.say).toContain(SAFARI_RELEASE_CALL);
    expect(out.hint).toContain('extension_release_status {include: ["stores"]}');
  });

  it("answers the state an inferred word carries with no next act", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve(record("inferred"));
    const out = JSON.parse(await submit({ action: "status", browsers: ["safari"], project: "acme/widget" }));

    expect(out.value.stores[0]).toMatchObject({ state: "PENDING_DEVELOPER_RELEASE", source: "inferred", nextStep: null });
    expect(out.value.nextStep).toBeNull();
  });

  it("refuses a store it cannot read before reading anything", async () => {
    const out = JSON.parse(await submit({ action: "status", browsers: ["opera"], project: "acme/widget" }));

    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("status reads chrome, firefox, edge, safari; got opera");
  });

  it("lists status among the actions, from the one list the handler checks too", () => {
    const action = (schema.inputSchema.properties.action as { enum: string[]; description: string });

    expect(action.enum).toEqual([...SUBMIT_ACTIONS]);
    expect(action.enum).toContain("status");
    expect(action.description).toContain("status reads, for each store in browsers");
  });

  it("names the store read when the action is unknown", async () => {
    const dispatch = createToolDispatcher({ tools, options: OPTIONS });
    const frame = await dispatch({ name: "extension_submit", arguments: { action: "state", browsers: ["safari"] } });
    const out = JSON.parse(frame.content[0]!.text);

    expect(out.status).toBe("invalid-arguments");
    expect(out.error.message).toContain(`must be one of: ${SUBMIT_ACTIONS.join(", ")}`);
    expect(out.error.message).toContain('extension_release_status {include: ["stores"]}');
    expect(out.hint).toContain('extension_submit {action: "status", browsers: [<store>]}');
  });
});
