import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../index";
import { writeCredentials } from "../lib/credentials";
import { resolveProjectRef } from "../lib/registry";
import { RegistryAccessTokens } from "../lib/registry-access";
import { FEATURE_GROUPS } from "../lib/tool-policy";
import { handler as publish } from "../tools/publish";
import { handler as promote } from "../tools/release-promote";
import { handler as releaseStatus } from "../tools/release-status";
import { promoteAnswer } from "./fixtures/platform-answers";

const KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_APPROVAL_GATE"];
const saved: Record<string, string | undefined> = {};
let tmp: string;
let urls: string[];
let bearers: string[];

const WS = "open-source-demo";
const NAMED = `${WS}/refined-github`;
const ACTIVE_SLUG = "zotero-connectors";

function login(projectSlug: string, workspaceSlug = WS) {
  writeCredentials({
    version: 1,
    token: `token-for-${projectSlug}`,
    workspaceSlug,
    projectSlug,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    api: "https://www.extension.dev",
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function platform(routes: {
  publish?: Record<string, unknown>;
  promote?: { status: number; body: Record<string, unknown> };
  submit?: Record<string, unknown>;
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: RequestInit) => {
      const href = String(url);
      urls.push(href);
      const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
      if (auth) bearers.push(auth);

      const registry = href.match(
        /registry\.extension\.land\/([^/]+)\/([^/]+)\/_extension-dev\/(.+?)(\?|$)/,
      );

      if (registry) {
        const slug = decodeURIComponent(String(registry[2]));

        if (registry[3] === "builds/index.json") {
          return json({
            items: [
              {
                sha: `sha-of-${slug}`,
                status: "success",
                timestamp: "2026-10-05T10:00:00.000Z",
                version: `1.0.0-${slug}`,
                channel: "preview",
              },
            ],
          });
        }

        if (registry[3] === "channels.json") {
          return json({ stable: { sha: `stable-of-${slug}` } });
        }

        return json({}, 404);
      }

      if (href.endsWith("/api/cli/publish")) {
        return json(routes.publish ?? { shareUrl: "https://share.test/x", visibility: "private" });
      }

      if (href.endsWith("/api/cli/release/promote")) {
        const route = routes.promote ?? { status: 200, body: promoteAnswer() };

        return json(route.body, route.status);
      }

      if (href.endsWith("/api/cli/stores/submit")) {
        return json(routes.submit ?? { ok: true, results: [] });
      }

      throw new Error(`Unexpected fetch: ${href}`);
    }),
  );
}

const registryReads = () => urls.filter((url) => url.includes("registry.extension.land"));

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-named-ref-"));
  process.env.XDG_CONFIG_HOME = tmp;
  delete process.env.EXTENSION_DEV_PROJECT;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_API_URL;
  process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
  urls = [];
  bearers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("named-project tests never reach the network");
    }),
  );

  login("refined-github");
  login("vue-devtools");
  login(ACTIVE_SLUG);
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }

  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveProjectRef", () => {
  it("splits a '<workspace>/<project>' handed in as project instead of gluing it to the active workspace", () => {
    expect(resolveProjectRef({ project: "acme/app" })).toEqual({ workspace: "acme", project: "app" });
    expect(resolveProjectRef({ workspace: "ACME", project: "acme/app" })).toEqual({
      workspace: "acme",
      project: "app",
    });
  });

  it("refuses a workspace that contradicts the one inside project", () => {
    expect(resolveProjectRef({ workspace: "globex", project: "acme/app" })).toBeNull();
    expect(resolveProjectRef({ project: "a/b/c" })).toBeNull();
  });

  it("takes a bare slug's workspace from the login that slug names", () => {
    login("solo", "other-workspace");
    login(ACTIVE_SLUG);
    expect(resolveProjectRef({ project: "solo" })).toEqual({
      workspace: "other-workspace",
      project: "solo",
    });

    expect(resolveProjectRef({ project: "nowhere" })).toEqual({ workspace: WS, project: "nowhere" });
    expect(resolveProjectRef({ workspace: "acme", project: "app" })).toEqual({
      workspace: "acme",
      project: "app",
    });
  });
});

describe("a private registry read asks its grant with the named project's login", () => {
  it("presents the token stored for the project the read is for", async () => {
    const sent: string[] = [];
    const tokens = new RegistryAccessTokens({
      fetchImpl: (async (_url: any, init?: RequestInit) => {
        sent.push(String((init?.headers as Record<string, string>).authorization));

        return json({ token: "grant", expiresAt: Math.floor(Date.now() / 1000) + 600 });
      }) as unknown as typeof fetch,
    });

    const grant = await tokens.get({ workspace: WS, project: "refined-github" });

    expect(grant.status).toBe("ok");
    expect(sent).toEqual(["Bearer token-for-refined-github"]);
  });

  it("still finds no credential for a project with no stored login", async () => {
    const tokens = new RegistryAccessTokens({
      fetchImpl: (async () => json({})) as unknown as typeof fetch,
    });
    const grant = await tokens.get({ workspace: "acme", project: "never-signed-in" });

    expect(grant.status).toBe("no-credential");
  });
});
