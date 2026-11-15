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
import * as publishTool from "../tools/publish";
import * as promoteTool from "../tools/release-promote";
import * as releaseStatusTool from "../tools/release-status";
import * as submitTool from "../tools/submit";
import { forwardable } from "../lib/hosted-forwarder";
import { forwardOf, useForwardLane } from "./fixtures/forward-lane";
import { promoteAnswer } from "./fixtures/platform-answers";

import type { ToolModule } from "../lib/tool-dispatch";

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

/* @invariant A PLATFORM TOOL CALLED WITH PROJECT IS FORWARDED AS THAT
 * PROJECT, WITH THAT PROJECT'S STORED LOGIN. The registry and platform reads
 * these cells used to watch now happen on the hosted lane, under the
 * credential this machine exchanged; what stays here, and what a wrong
 * binding would break, is which login is exchanged and which project the
 * lane is asked for.
 */
describe("a platform tool called with project is forwarded as that project's login, never the active one", () => {
  const lane = useForwardLane();
  const forwarded = (module: unknown) => forwardable(module as ToolModule).handler as (args: Record<string, unknown>) => Promise<string>;

  const askedAs = (slug: string) => {
    expect(lane.exchanged()).toEqual([`Bearer token-for-${slug}`]);
    expect(lane.lane().map((hit) => [hit.authorization, hit.project])).toEqual([[forwardOf(`token-for-${slug}`), `${WS}/${slug}`]]);
  };

  it.each([
    ["extension_publish", publishTool, {}],
    ["extension_release_promote", promoteTool, { buildId: "abc1234", channel: "preview" }],
    ["extension_submit", submitTool, { buildSha: "abc1234", browsers: ["chrome"] }],
    ["extension_release_status", releaseStatusTool, { include: ["releases"] }],
  ] as const)("%s asks the lane for the named project with its own login, and names the active one nowhere", async (tool, module, args) => {
    const out = JSON.parse(await forwarded(module)({ project: NAMED, ...args }));

    expect(out.ok).toBe(true);
    askedAs("refined-github");
    expect(lane.lane()[0]).toMatchObject({ tool, args: { project: NAMED } });
    expect(JSON.stringify(lane.seen)).not.toContain(ACTIVE_SLUG);
  });

  it("does the same for each of several named projects in turn", async () => {
    for (const slug of ["refined-github", "vue-devtools", ACTIVE_SLUG]) {
      lane.seen.length = 0;
      await forwarded(publishTool)({ project: `${WS}/${slug}` });

      askedAs(slug);
    }
  });

  it("still asks as the active login when no project is named", async () => {
    await forwarded(publishTool)({});

    askedAs(ACTIVE_SLUG);
  });

  it("answers a project named as '<workspace>/<project>' that has no stored login by that name, never a glued address, and sends nothing", async () => {
    const out = JSON.parse(await forwarded(releaseStatusTool)({ project: "acme/app", include: ["releases"] }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("auth-required");
    expect(out.error.message).toContain("acme/app");
    expect(JSON.stringify(out)).not.toContain("%2F");
    expect(JSON.stringify(out)).not.toContain(`${WS}/acme`);
    expect(lane.sentAnything()).toBe(false);
  });

  it("asks for the pinned project on a pinned server, not the active login's", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer({ features: [...FEATURE_GROUPS], noShip: false, project: NAMED }).connect(serverTransport);
    const client = new Client({ name: "named-ref-probe", version: "0.0.0" });
    await client.connect(clientTransport);

    await client.callTool({ name: "extension_release_status", arguments: { include: ["releases"] } });

    askedAs("refined-github");
    expect(JSON.stringify(lane.lane())).not.toContain("%2F");
  });
});
