import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readStores as handler } from "../tools/store-status";
import { STORE_RECORD_ABSENT } from "../lib/store-readiness";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function fetchByFile(files: Record<string, unknown>, otherwise = jsonResponse({ message: "not found" }, false, 404)): typeof fetch {
  return (async (url: string) => {
    for (const [suffix, body] of Object.entries(files)) {
      if (String(url).endsWith(suffix)) return jsonResponse(body);
    }

    return otherwise;
  }) as unknown as typeof fetch;
}

const HEALTH = {
  schemaVersion: 1,
  updatedAt: "2026-07-22T17:05:43.522Z",
  stores: {
    chrome: { ok: true, message: "Credentials verified.", checkedAt: "2026-07-22T17:05:43.522Z" },
  },
};

const SUBMISSIONS = {
  updatedAt: "2026-07-22T17:25:05.000Z",
  submissions: [
    {
      id: "sub-new",
      store: "firefox",
      channel: "stable",
      version: "1.0.2",
      status: "submitted",
      submittedAt: "2026-07-22T17:25:05.000Z",
      storeUrl: "https://addons.mozilla.org/firefox/addon/probe",
    },
  ],
};

describe("extension_release_status reads an absent store record as not written yet", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-store-status-absent-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("answers the readiness reader's no-record sentences on a 404 for health.json and status.json", async () => {
    global.fetch = fetchByFile({ "stores/submissions.json": SUBMISSIONS });

    const out = JSON.parse(await handler({ workspace: "acme", project: "widget" }));
    const warnings = out.warnings.join(" ");

    expect(out.ok).toBe(true);
    expect(warnings).toContain(STORE_RECORD_ABSENT.health);
    expect(warnings).toContain("a store connect or a credential recheck triggers one");
    expect(warnings).toContain(STORE_RECORD_ABSENT.status);
    expect(warnings).toContain("extension_submit runs one");
    expect(warnings).toContain("/acme/widget/submissions");
    expect(warnings).not.toContain("unreadable");
    expect(out.hint).toContain("configuration unknown (no store health record yet)");
  });

  it("keeps unreadable for a 503 on either file", async () => {
    global.fetch = fetchByFile(
      { "stores/submissions.json": SUBMISSIONS },
      jsonResponse({ message: "upstream unavailable" }, false, 503),
    );

    const out = JSON.parse(await handler({ workspace: "acme", project: "widget" }));
    const warnings = out.warnings.join(" ");

    expect(warnings).toContain("stores/health.json unreadable: ");
    expect(warnings).toContain("stores/status.json unreadable: ");
    expect(warnings).toContain("returned 503");
    expect(warnings).not.toContain("no store health record");
    expect(warnings).not.toContain("no store status record");
    expect(out.hint).toContain("configuration unknown (stores/health.json is unreadable)");
  });

  it("reads a 404 on submissions.json as no submissions recorded, never as unknown", async () => {
    global.fetch = fetchByFile({ "stores/health.json": HEALTH });

    const out = JSON.parse(await handler({ workspace: "acme", project: "widget" }));

    expect(out.hint).toContain("chrome: configured, credentials healthy");
    expect(out.hint).toContain("no submissions recorded");
    expect(out.hint).not.toContain("submissions unknown");
  });
});
