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
import { handler as submit } from "../tools/submit";
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

describe("extension_publish with project", () => {
  it("returns the registry address of the project it was called for", async () => {
    platform({ publish: { shareUrl: "https://share.test/x", buildSha: "abc1234", version: "9.9.9", builtAt: "2026-10-05T09:00:00.000Z" } });
    const out = JSON.parse(await publish({ project: NAMED }));

    expect(out.ok).toBe(true);
    expect(out.value.registryUrl).toBe(
      `https://registry.extension.land/${WS}/refined-github/_extension-dev/builds/index.json`,
    );

    expect(JSON.stringify(out)).not.toContain(ACTIVE_SLUG);
    expect(bearers).toEqual(["Bearer token-for-refined-github"]);
  });

  it("fills a missing build sha and version from the named project's index, never the active one's", async () => {
    platform({ publish: { shareUrl: "https://share.test/x", visibility: "private" } });
    const out = JSON.parse(await publish({ project: NAMED }));

    expect(out.value.buildSha).toBe("sha-of-refined-github");
    expect(out.value.version).toBe("1.0.0-refined-github");
    expect(registryReads()).toHaveLength(1);
    expect(registryReads()[0]).toContain("/refined-github/");
  });

  it("does the same for each of several named projects in turn", async () => {
    platform({ publish: { shareUrl: "https://share.test/x" } });

    for (const slug of ["refined-github", "vue-devtools", ACTIVE_SLUG]) {
      const out = JSON.parse(await publish({ project: `${WS}/${slug}` }));
      expect(out.value.registryUrl).toContain(`/${slug}/_extension-dev/`);
      expect(out.value.buildSha).toBe(`sha-of-${slug}`);
    }
  });

  it("still describes the active login when no project is named", async () => {
    platform({ publish: { shareUrl: "https://share.test/x" } });
    const out = JSON.parse(await publish({}));

    expect(out.value.registryUrl).toContain(`/${ACTIVE_SLUG}/_extension-dev/`);
  });
});

describe("the sibling tools that take project", () => {
  it("extension_release_promote points a failed promote at the named project's builds and channels", async () => {
    platform({ promote: { status: 404, body: { message: "unknown build", code: "UNKNOWN_BUILD" } } });
    const out = JSON.parse(
      await promote({ project: NAMED, buildId: "abc1234", channel: "preview" } as never),
    );

    expect(out.ok).toBe(false);
    expect(out.value.buildsPageUrl).toContain(`/${WS}/refined-github`);
    expect(out.value.registryChannelsUrl).toContain("/refined-github/_extension-dev/channels.json");
    expect(out.value.validChannelShas).toEqual({ stable: "stable-of-refined-github" });
    expect(JSON.stringify(out)).not.toContain(ACTIVE_SLUG);
  });

  it("extension_release_promote returns the named project's public pages on success", async () => {
    platform({ promote: { status: 200, body: promoteAnswer() } });
    const out = JSON.parse(
      await promote({ project: NAMED, buildId: "abc1234", channel: "preview" } as never),
    );

    expect(out.ok).toBe(true);
    expect(JSON.stringify(out.value)).toContain("refined-github");
    expect(JSON.stringify(out)).not.toContain(ACTIVE_SLUG);
  });

  it("extension_submit names the named project's console page on a dry run", async () => {
    platform({ submit: { ok: true, results: [] } });
    const out = await submit({
      project: NAMED,
      buildSha: "abc1234",
      browsers: ["chrome"],
    } as never);

    expect(out).toContain(`/${WS}/refined-github/`);
    expect(out).not.toContain(ACTIVE_SLUG);
  });

  it("extension_release_status reads the project named as '<workspace>/<project>'", async () => {
    platform();
    await releaseStatus({ project: "acme/app", include: ["releases"] });

    expect(registryReads().length).toBeGreaterThan(0);

    for (const url of registryReads()) {
      expect(url).toContain("registry.extension.land/acme/app/_extension-dev/");
      expect(url).not.toContain("%2F");
    }
  });

  it("extension_release_status on a pinned server reads the pinned project, not a glued address", async () => {
    platform();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer({ features: [...FEATURE_GROUPS], noShip: false, project: NAMED }).connect(serverTransport);
    const client = new Client({ name: "named-ref-probe", version: "0.0.0" });
    await client.connect(clientTransport);
    process.env.EXTENSION_DEV_PROJECT = NAMED;

    await client.callTool({ name: "extension_release_status", arguments: { include: ["releases"] } });

    expect(registryReads().length).toBeGreaterThan(0);

    for (const url of registryReads()) {
      expect(url).toContain(`registry.extension.land/${WS}/refined-github/_extension-dev/`);
      expect(url).not.toContain("%2F");
    }
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
