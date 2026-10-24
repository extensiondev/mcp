// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const API = "http://localhost:3100";
const APPROVAL_ID = "apr_J3pJzcFuh6UWFwP_AMwl_IZ085Ookc_R";
const APPROVAL_URL = `${API}/device/approve/${APPROVAL_ID}`;
const REFUSED = "Unrecognized release token. Mint one in project settings.";
const KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_API_URL"];

const PROJECTS = {
  leon: { token: tokenFor("acme", "leon", "tok_leon_first"), projectId: "prj_leon" },
  rebeccat: { token: tokenFor("acme", "rebeccat", "tok_rebeccat"), projectId: "prj_rebeccat" },
};

const CURRENT = {
  chrome: { enabled: true, installCommand: "npm install", buildCommand: "npm run build -- --browser chrome", outputDirectory: "dist/chrome" },
  edge: { enabled: false, installCommand: "", buildCommand: "", outputDirectory: "" },
  firefox: { enabled: false, installCommand: "npm install", buildCommand: "npm run build -- --browser firefox", outputDirectory: "dist/firefox" },
  safari: { enabled: false, installCommand: "", buildCommand: "", outputDirectory: "" },
};

type Call = { url: string; method: string; auth: string; body: any };
type Refusal = "none" | "mint" | "confirm";

function tokenFor(workspace: string, project: string, nonce: string): string {
  return `${Buffer.from(JSON.stringify({ u: workspace, p: project, n: nonce })).toString("base64url")}.sig`;
}

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

function digestOf(settings: Record<string, any>): string {
  const canonical: Record<string, unknown> = {};

  for (const browser of ["chrome", "edge", "firefox", "safari"]) {
    const config = settings[browser];
    if (!config) continue;

    canonical[browser] = {
      enabled: config.enabled,
      installCommand: config.installCommand,
      buildCommand: config.buildCommand,
      outputDirectory: config.outputDirectory,
    };
  }

  return sha256(JSON.stringify(canonical));
}

const MERGED = { chrome: CURRENT.chrome, edge: CURRENT.edge, firefox: { ...CURRENT.firefox, enabled: true } };
const LIVE_EXPIRES_AT = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const FINGERPRINT = sha256(`extension_settings.build\nsettingsDigest=${digestOf(MERGED)}`);

function projectOf(auth: string): { token: string; projectId: string } | null {
  const token = auth.replace(/^Bearer\s+/i, "");

  return Object.values(PROJECTS).find((entry) => entry.token === token) ?? null;
}

const saved: Record<string, string | undefined> = {};
let tmp: string;
let calls: Call[];
let mints: number;
let refusal: Refusal;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function platform(url: string, init?: RequestInit): Response {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const method = String(init?.method ?? "GET").toUpperCase();
  const auth = String(headers.authorization ?? "");
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url, method, auth, body });
  const who = projectOf(auth);
  const pathname = new URL(url).pathname;

  if (!who) return json({ message: REFUSED, code: "TOKEN_NOT_TRACKED" }, 401);
  if (pathname === "/api/cli/whoami") return json({ login: "ok", live: true, projectId: who.projectId });

  if (pathname === `/api/projects/${who.projectId}/settings/build` && method === "GET") return json({ buildSettings: CURRENT });

  if (pathname === `/api/projects/${who.projectId}/settings/build` && method === "PUT") {
    if (body?.approvalId === APPROVAL_ID) return json({ buildSettings: MERGED });

    return json(
      {
        code: "APPROVAL_REQUIRED",
        message: "needs approval",
        approvalRequest: { action: "extension_settings.build", scope: { settingsDigest: digestOf(MERGED) }, fingerprint: FINGERPRINT },
      },
      403,
    );
  }

  if (pathname === "/api/cli/approvals" && method === "POST") {
    if (refusal === "mint") return json({ message: REFUSED, code: "TOKEN_NOT_TRACKED" }, 401);

    mints += 1;

    return json(
      { approvalId: APPROVAL_ID, approvalUrl: APPROVAL_URL, expiresAt: LIVE_EXPIRES_AT, description: "Change the build settings of leon: firefox: enable" },
      201,
    );
  }

  if (pathname === `/api/cli/approvals/${APPROVAL_ID}` && method === "GET") {
    if (refusal === "confirm") return json({ message: REFUSED, code: "TOKEN_NOT_TRACKED" }, 401);

    return who.projectId === PROJECTS.leon.projectId
      ? json({ status: "approved", fingerprint: FINGERPRINT, expiresAt: LIVE_EXPIRES_AT, used: false, approver: "cezar" })
      : json({ message: "Unknown approval", code: "APPROVAL_UNKNOWN" }, 404);
  }

  return json({ message: `unexpected ${method} ${pathname}` }, 500);
}

async function freshServer(): Promise<Client> {
  vi.resetModules();
  const { createServer } = await import("../index");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ features: ["local", "platform"], noShip: false }).connect(serverTransport);

  const client = new Client({ name: "approval-login-rebuild-probe", version: "0.0.0" });
  await client.connect(clientTransport);

  return client;
}

async function call(client: Client, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name: "extension_builds", arguments: { action: "configure", buildSettings: { firefox: { enabled: true } }, ...args } });

  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

async function login(project: "leon" | "rebeccat"): Promise<void> {
  const { writeCredentials } = await import("../lib/credentials");
  writeCredentials({
    version: 1,
    token: PROJECTS[project].token,
    workspaceSlug: "acme",
    projectSlug: project,
    projectId: PROJECTS[project].projectId,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    api: API,
  });
}

async function mintUnderLeon(): Promise<void> {
  await login("leon");
  const minted = await call(await freshServer(), {});

  expect(minted.status).toBe("approval-required");
  expect(minted.value.approvalId).toBe(APPROVAL_ID);
}

const bearers = () => [...new Set(calls.map((entry) => entry.auth))];

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-approval-login-rebuild-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  delete process.env.EXTENSION_DEV_PROJECT;
  delete process.env.EXTENSION_DEV_TOKEN;
  calls = [];
  mints = 0;
  refusal = "none";
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: RequestInit) => platform(String(url), init)));
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }

  vi.unstubAllGlobals();
  vi.resetModules();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a retry with an approvalId is made with the login that requested the approval", () => {
  it("records the login's id beside the project, never the token", async () => {
    if (process.platform === "win32") return;

    await mintUnderLeon();

    const { approvalRecordPath, mintedApproval } = await import("../lib/approval-record");
    const record = mintedApproval(undefined, APPROVAL_ID);

    expect(record).toMatchObject({ workspace: "acme", project: "leon", projectId: "prj_leon", loginId: "tok_leon_first" });
    expect(fs.readFileSync(approvalRecordPath(), "utf8")).not.toContain(PROJECTS.leon.token);
    expect(JSON.stringify(record)).not.toContain(PROJECTS.leon.token.split(".")[0]);
  });

  it("confirms and executes under the requesting login after a rebuild whose newest login is another project", async () => {
    if (process.platform === "win32") return;

    await mintUnderLeon();
    await login("rebeccat");
    calls = [];

    const retried = await call(await freshServer(), { approvalId: APPROVAL_ID });

    expect(retried.ok).toBe(true);
    expect(retried.status).toBe("build-configured");
    expect(retried.value.project).toBe("acme/leon");
    expect(retried.value.trackUrl).toContain("/leon");

    const confirm = calls.find((entry) => entry.url.endsWith(`/api/cli/approvals/${APPROVAL_ID}`));
    const written = calls.find((entry) => entry.method === "PUT");

    expect(confirm?.auth).toBe(`Bearer ${PROJECTS.leon.token}`);
    expect(written?.auth).toBe(`Bearer ${PROJECTS.leon.token}`);
    expect(written?.body.approvalId).toBe(APPROVAL_ID);
    expect(bearers()).toEqual([`Bearer ${PROJECTS.leon.token}`]);
    expect(mints).toBe(1);
  });

  it("answers the sign-in sentence with no platform call when the requesting login is gone from the store", async () => {
    if (process.platform === "win32") return;

    await mintUnderLeon();
    await login("rebeccat");

    const { clearCredentials, listCredentials } = await import("../lib/credentials");

    expect(clearCredentials({ project: "acme/leon", api: API }).removed).toEqual([`${API} acme/leon`]);
    expect(listCredentials().map((entry) => entry.projectSlug)).toEqual(["rebeccat"]);

    calls = [];
    const gone = await call(await freshServer(), { approvalId: APPROVAL_ID });

    expect(gone.ok).toBe(false);
    expect(gone.status).toBe("auth-required");
    expect(gone.error).toMatchObject({ code: "E_AUTH_REQUIRED", name: "ApprovalLoginGone" });
    expect(gone.error.message).toContain("the login that requested this approval is no longer stored; sign in to acme/leon again and request a new approval");
    expect(gone.error.message).not.toContain(PROJECTS.leon.token);
    expect(gone.hint).toContain('extension_auth (action: login, project: "acme/leon")');
    expect(gone.value).toMatchObject({ approvalId: APPROVAL_ID, mintedFor: "acme/leon", action: "extension_settings.build" });
    expect(gone.value.trackUrl).toContain("/leon");
    expect(calls).toEqual([]);
  });

  it("still refuses a retry that names another project before the platform is asked", async () => {
    if (process.platform === "win32") return;

    await mintUnderLeon();
    await login("rebeccat");
    calls = [];

    const other = await call(await freshServer(), { approvalId: APPROVAL_ID, project: "acme/rebeccat" });

    expect(other.ok).toBe(false);
    expect(other.status).toBe("approval-rejected");
    expect(other.error.name).toBe("ApprovalOtherProject");
    expect(other.value).toMatchObject({ approvalId: APPROVAL_ID, mintedFor: "acme/leon", named: "acme/rebeccat" });
    expect(calls).toEqual([]);
  });

  it("answers the platform's 401 on the request as the login's refusal and mints nothing", async () => {
    if (process.platform === "win32") return;

    await login("leon");
    refusal = "mint";

    const refused = await call(await freshServer(), {});

    expect(refused.ok).toBe(false);
    expect(refused.status).toBe("auth-required");
    expect(refused.error).toMatchObject({ code: "E_AUTH_REQUIRED", name: "LoginRefused" });
    expect(refused.error.message).toBe(
      `The platform did not recognize the login this call used for acme/leon (401): ${REFUSED.replace(/\.$/, "")}. No approval was requested and nothing was executed.`,
    );

    expect(refused.hint).toContain('extension_auth (action: login, project: "acme/leon")');
    expect(refused.value.approvalId).toBeUndefined();
    expect(refused.value.login).toBe("acme/leon");
    expect(refused.value.trackUrl).toContain("/leon");
    expect(mints).toBe(0);

    const { mintedApproval } = await import("../lib/approval-record");

    expect(mintedApproval(undefined, APPROVAL_ID)).toBeNull();
    expect(bearers()).toEqual([`Bearer ${PROJECTS.leon.token}`]);
  });

  it("answers the platform's 401 on the confirmation as the login's refusal, keeps the approvalId and executes nothing", async () => {
    if (process.platform === "win32") return;

    await mintUnderLeon();
    refusal = "confirm";
    calls = [];

    const refused = await call(await freshServer(), { approvalId: APPROVAL_ID });

    expect(refused.ok).toBe(false);
    expect(refused.status).toBe("auth-required");
    expect(refused.error).toMatchObject({ code: "E_AUTH_REQUIRED", name: "ApprovalLoginRefused" });
    expect(refused.error.message).toContain(`did not recognize the login that requested approval ${APPROVAL_ID} for acme/leon (401)`);
    expect(refused.error.message).toContain("The approval itself was not consulted and nothing was executed");
    expect(refused.error.message).toContain(`until ${LIVE_EXPIRES_AT}`);
    expect(refused.error.message).not.toContain("no approvalId");
    expect(refused.hint).toContain(`approvalId ${APPROVAL_ID}`);
    expect(refused.value).toMatchObject({ approvalId: APPROVAL_ID, login: "acme/leon", mintedFor: "acme/leon" });
    expect(refused.value.trackUrl).toContain("/leon");
    expect(calls.some((entry) => entry.method === "PUT")).toBe(false);
    expect(mints).toBe(1);
  });
});
