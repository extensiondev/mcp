import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as releaseStatus, schema } from "../tools/release-status";
import { trackFields } from "../lib/track-url";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const ALPHA_ID = "prj_alpha";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const CHROME = {
  store: "chrome",
  listing: {
    title: "PII Shield",
    shortDescription: "Hide personal information on every open tab.",
    fullDescription: "PII Shield blurs emails and phone numbers.",
    categories: ["Productivity"],
    supportEmail: "hello@acme.test",
    privacyPolicyUrl: "https://acme.test/privacy",
    privacyPolicyAttested: true,
    singlePurpose: "Hide personal information.",
    searchTerms: ["privacy", "pii"],
    permissionJustifications: [{ permission: "storage", justification: "Remembers the list." }],
    reviewerNotes: "Test account: none needed.",
    secretToken: "never-answered",
  },
  media: { icons: [{ sha256: "a".repeat(64), width: 128, height: 128 }], screenshots: [] },
  updatedAt: "2026-10-22T10:00:00.000Z",
};

const FIREFOX = { store: "firefox", listing: {}, media: {}, updatedAt: null };

describe("extension_release_status include listing", () => {
  let tmp: string;
  let saved: Record<string, string | undefined>;
  let prevFetch: typeof fetch;
  let calls: string[];
  let routes: Record<string, { body: unknown; status?: number }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-listing-read-"));
    saved = {};

    for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }

    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    calls = [];
    routes = {
      [`/api/projects/${ALPHA_ID}/stores/chrome/listing`]: { body: CHROME },
      [`/api/projects/${ALPHA_ID}/stores/firefox/listing`]: { body: FIREFOX },
      [`/api/projects/${ALPHA_ID}/stores/edge/listing`]: { body: { store: "edge", listing: {}, media: {} } },
      [`/api/projects/${ALPHA_ID}/stores/safari/listing`]: { body: { message: "The store listing could not be read. Try again.", code: "LISTING_UNREADABLE" }, status: 503 },
    };

    global.fetch = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push(target);
      const pathname = new URL(target).pathname;

      if (pathname === "/api/cli/whoami") {
        return headers.authorization === "Bearer alpha.sig"
          ? jsonResponse({ live: true, projectId: ALPHA_ID, workspaceSlug: "acme", projectSlug: "alpha" })
          : jsonResponse({ message: "bad" }, 401);
      }

      const route = routes[pathname];

      return route ? jsonResponse(route.body, route.status ?? 200) : jsonResponse({ message: "not found" }, 404);
    }) as unknown as typeof fetch;

    writeCredentials({
      version: 1,
      token: "alpha.sig",
      workspaceSlug: "acme",
      projectSlug: "alpha",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("offers listing in the include enum with a store input", () => {
    const props = schema.inputSchema.properties as Record<string, { enum?: string[]; items?: { enum: string[] } }>;

    expect(props.include.items?.enum).toContain("listing");
    expect(props.store.enum).toEqual(["chrome", "firefox", "edge", "safari"]);
  });

  it("never answers a listing field it does not name", async () => {
    if (process.platform === "win32") return;

    const raw = await releaseStatus({ include: ["listing"], store: "chrome", api: API });

    expect(raw).not.toContain("never-answered");
    expect(raw).not.toContain("secretToken");
    expect(raw).not.toContain("a".repeat(64));
  });

  it("tracks a listing read on the store's console page", () => {
    const one = trackFields("extension_release_status", {
      args: { include: ["listing"], store: "firefox", project: "acme/alpha" },
      status: "read",
      value: {},
    });
    const all = trackFields("extension_release_status", {
      args: { include: ["listing"], project: "acme/alpha" },
      status: "read",
      value: {},
    });

    expect(one?.trackUrl).toContain("/acme/alpha/submissions/firefox");
    expect(all?.trackUrl).toMatch(/\/acme\/alpha\/submissions$/);
  });
});
