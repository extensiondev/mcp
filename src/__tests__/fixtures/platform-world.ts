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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach } from "vitest";

import { createServer } from "../../index";
import { writeCredentials } from "../../lib/credentials";

export const WORLD_API = "http://localhost:3100";
export const WORLD_PROJECT_ID = "prj_world";
export const FULL_SHA = "603fc8a6b1e2d3c4f5a6b7c8d9e0f1a2b3c4d5e6";
export const MIRROR_REPO = "extension-user-land-dev/4672033--prj_0f6c1d2e-9a8b-4c7d-8e6f-5a4b3c2d1e0f";
export const MIRROR_RUN_URL = `https://github.com/${MIRROR_REPO}/actions/runs/18234567890`;
export const PROD_MIRROR_RUN_URL = "https://github.com/extension-user-land/4672033--prj_0f6c1d2e/actions/runs/18234567891/job/5";

type Row = Record<string, unknown>;
export type WorldReply = { body: unknown; status?: number };
export type WorldCall = { method: string; path: string; url: string; body: any };
export type WorldRoute = (call: WorldCall) => WorldReply | undefined;

const P = `/api/projects/${WORLD_PROJECT_ID}`;

const build = (overrides: Row = {}): Row => ({
  buildId: "603fc8a",
  commit: FULL_SHA,
  status: "failed",
  buildEnv: "staging",
  channel: "beta",
  browsers: [{ name: "chrome" }],
  startedAt: "2026-10-19T10:00:00.000Z",
  runId: 18234567890,
  runUrl: MIRROR_RUN_URL,
  repository: MIRROR_REPO,
  deploymentId: "dep_1",
  failureCause: { jobName: "build", stepName: "Checkout", runUrl: MIRROR_RUN_URL },
  ...overrides,
});

function mirrorLogs(): Row {
  return {
    buildId: "603fc8a",
    runUrl: PROD_MIRROR_RUN_URL,
    run: {
      status: "completed",
      conclusion: "failure",
      failedJob: {
        name: "build",
        step: "Checkout",
        lines: [`Syncing repository: ${MIRROR_REPO}`, `See ${MIRROR_RUN_URL} for details`],
      },
    },
    items: [
      {
        browser: "chrome",
        status: "failed",
        summarized: false,
        reason: `The CI run on the mirror failed; read the run's annotations at ${MIRROR_RUN_URL}.`,
        logs: [{ level: "info", message: `git clone https://github.com/${MIRROR_REPO}.git` }],
      },
    ],
  };
}

const DEFAULT_ROUTES: Array<[RegExp, WorldRoute]> = [
  [/^GET \/api\/cli\/whoami$/, () => ({ body: { login: "acme/widget", live: true, projectId: WORLD_PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" } })],
  [/^GET \/api\/cli\/login\/config$/, () => ({ body: { deviceCodeUrl: "/api/cli/device/code", deviceTokenUrl: "/api/cli/device/token", verificationUri: `${WORLD_API}/device` } })],
  [/^POST \/api\/cli\/device\/code$/, () => ({ body: { device_code: "dev_1", user_code: "ABCD-EFGH", verification_uri: `${WORLD_API}/device`, verification_uri_complete: `${WORLD_API}/device?code=ABCD-EFGH`, expires_in: 600, interval: 30 } })],
  [/^GET \/api\/projects\/resolve$/, () => ({ body: { exists: true } })],
  [/^POST \/api\/cli\/approvals$/, () => ({ body: { approvalId: "apr_world", approvalUrl: `${WORLD_API}/device/approve/apr_world`, expiresAt: "2026-10-19T11:00:00.000Z" } })],
  [/^GET \/api\/cli\/approvals\/[^/]+$/, () => ({ body: { status: "approved", used: false } })],
  [new RegExp(`^GET ${P}/builds$`), () => ({ body: { items: [build(), build({ buildId: "1a2b3c4", commit: "1a2b3c4".padEnd(40, "0"), status: "success", runId: 18234567000 })] } })],
  [new RegExp(`^GET ${P}/builds/[^/]+/logs$`), () => ({ body: mirrorLogs() })],
  [new RegExp(`^GET ${P}/builds/[^/]+/artifacts$`), () => ({ body: [] })],
  [new RegExp(`^GET ${P}/builds/[^/]+/usage$`), () => ({ body: {} })],
  [new RegExp(`^GET ${P}/builds/[^/]+/integrity/[^/]+$`), () => ({ body: { ok: true, checks: [] } })],
  [new RegExp(`^POST ${P}/builds/dispatch$`), () => ({ body: { commit: FULL_SHA, browsers: "chrome", branch: "main", deploymentId: "dep_2", dispatchedAt: "2026-10-19T10:05:00.000Z", runId: 18234567999, runUrl: MIRROR_RUN_URL, runCorrelation: `rebuild-${MIRROR_REPO}` } })],
  [new RegExp(`^GET ${P}/builds/[^/]+$`), () => ({ body: build() })],
  [new RegExp(`^GET ${P}/settings/build$`), () => ({ body: { buildSettings: { chrome: { enabled: true, buildCommand: "npm run build" } } } })],
  [new RegExp(`^PUT ${P}/settings/build$`), () => ({ body: { ok: true, buildSettings: { firefox: { enabled: true, buildCommand: "pnpm build" } } } })],
  [new RegExp(`^GET ${P}/settings/general$`), () => ({ body: { visibility: "private" } })],
  [new RegExp(`^POST ${P}/channels$`), () => ({ body: { ok: true, channel: { name: "nightly", audience: "private" } } })],
  [new RegExp(`^GET ${P}/channels$`), () => ({ body: [] })],
  [new RegExp(`^GET ${P}/releases/promotion-runs$`), () => ({ body: { since: "2026-10-12", recent: [{ browser: "chrome", channel: "beta", status: "completed", conclusion: "success", runId: 18234567892, url: MIRROR_RUN_URL, htmlUrl: MIRROR_RUN_URL }] } })],
  [new RegExp(`^GET ${P}/releases$`), () => ({ body: { items: [{ id: "rel_1", channel: "beta", buildId: "603fc8a", runUrl: MIRROR_RUN_URL }] } })],
  [/^POST \/api\/cli\/release\/promote$/, () => ({ body: { ok: true, status: "ok", mirrorSync: { ok: true, pending: [] }, buildId: "603fc8a", targetChannel: "beta", queuedBrowsers: ["chrome"], failedBrowsers: [], dispatchedAt: "2026-10-19T10:00:00.000Z", runUrl: MIRROR_RUN_URL, promotions: [{ browser: "chrome", dispatchId: "d-1", correlation: "run-name", runUrl: MIRROR_RUN_URL }] } })],
  [/^POST \/api\/cli\/publish$/, () => ({ body: { shareUrl: "https://acme.extension.dev/widget/builds/603fc8a?share=tok", visibility: "private", buildSha: "603fc8a", version: "1.0.0", expiresAt: "2026-10-26T10:00:00.000Z" } })],
  [/^POST \/api\/cli\/stores\/submit$/, () => ({ body: { ok: true, projectId: WORLD_PROJECT_ID, buildId: "603fc8a", channel: "stable", submissions: [{ id: "sub_1", store: "chrome", status: "pending", workflowRunId: 77, workflowRunUrl: MIRROR_RUN_URL }] } })],
  [/^GET \/api\/workspaces\/[^/]+$/, () => ({ body: { workspace: { id: "ws_acme", slug: "acme", displayName: "Acme", currentUserRole: "owner", projectCount: 1, memberCount: 1 } } })],
  [/^GET \/api\/projects$/, () => ({ body: { projects: [{ id: WORLD_PROJECT_ID, slug: "widget", name: "widget", visibility: "private", repo: MIRROR_REPO }] } })],
  [/^POST \/api\/cli\/device\/token$/, () => ({ status: 400, body: { error: "authorization_pending" } })],
  [new RegExp(`^POST ${P}/stores/[^/]+/submissions/preflight$`), () => ({ body: { ready: true, checks: [], warnings: [] } })],
  [/^GET \/api\/local-registry\/acme\/widget\/_extension-dev\/channels\.json$/, () => ({ body: { beta: { sha: "603fc8a", runUrl: MIRROR_RUN_URL } } })],
  [/^GET \/api\/local-registry\/acme\/widget\/_extension-dev\/meta\.json$/, () => ({ body: { visibility: "private" } })],
  [/^GET \/api\/local-registry\/acme\/widget\/_extension-dev\/builds\/index\.json$/, () => ({ body: { items: [{ sha: "603fc8a", status: "success", timestamp: "2026-10-19T10:00:00.000Z", runUrl: MIRROR_RUN_URL }] } })],
  [/^DELETE \/api\/artifacts\/gen_[a-f0-9]+$/, () => ({ body: { ok: true, revokedAt: "2026-10-19T10:00:00.000Z" } })],
  [/^POST \/api\/artifacts$/, () => ({ body: { artifactId: `gen_${"ab".repeat(32)}`, previewUrl: "http://preview.extension.localhost/?preview=gen_ab", zipUrl: `${WORLD_API}/api/artifacts/gen_ab/source.zip`, revokeUrl: `${WORLD_API}/api/artifacts/gen_ab`, expiresAt: "2026-10-26T00:00:00.000Z" } })],
  [/^GET \/api\/artifacts$/, () => ({ body: { artifacts: [], truncated: false } })],
];

export interface World {
  calls: WorldCall[];
  missed: string[];
  routes: Array<[RegExp, WorldRoute]>;
  login: () => void;
  call: (name: string, args: Row) => Promise<any>;
}

function jsonResponse({ body, status = 200 }: WorldReply): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function usePlatformWorld(prefix: string): World {
  const world: World = {
    calls: [],
    missed: [],
    routes: [],
    login: () =>
      writeCredentials({
        version: 1,
        token: "claims.sig",
        workspaceSlug: "acme",
        projectSlug: "widget",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        api: WORLD_API,
      }),
    call: async (name, args) => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await createServer({ features: ["local", "platform"], noShip: false }).connect(serverTransport);
      const client = new Client({ name: "world-probe", version: "0.0.0" });
      await client.connect(clientTransport);
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);

      return JSON.parse(json);
    },
  };
  let tmp = "";
  const saved: Record<string, string | undefined> = {};
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

    for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_APPROVAL_GATE", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_CONSOLE_URL"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }

    process.env.XDG_CONFIG_HOME = tmp;
    world.calls.length = 0;
    world.missed.length = 0;
    world.routes.length = 0;
    prevFetch = global.fetch;

    global.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const parsed = new URL(url);
      const method = String(init?.method ?? "GET").toUpperCase();
      let body: unknown;

      try {
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      } catch {
        body = undefined;
      }

      const call: WorldCall = { method, path: parsed.pathname, url, body };
      world.calls.push(call);
      const key = `${method} ${parsed.pathname}`;

      for (const [pattern, route] of [...world.routes, ...DEFAULT_ROUTES]) {
        if (!pattern.test(key)) continue;
        const reply = route(call);
        if (reply) return jsonResponse(reply);
      }

      world.missed.push(key);

      return jsonResponse({ body: { message: "not found" }, status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = prevFetch;

    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  return world;
}
