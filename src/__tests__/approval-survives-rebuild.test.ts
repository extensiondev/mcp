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
const SECOND_ID = "apr_rS0P0RbO3UsOyG3zy4DN4NQHxlixx7Kt";
const APPROVAL_URL = `${API}/device/approve/${APPROVAL_ID}`;
const SECOND_URL = `${API}/device/approve/${SECOND_ID}`;
const KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_API_URL"];

const PROJECTS = {
  leon: { token: tokenFor("acme", "leon"), projectId: "prj_leon" },
  rebeccat: { token: tokenFor("acme", "rebeccat"), projectId: "prj_rebeccat" },
};

const CURRENT = {
  chrome: { enabled: true, installCommand: "npm install", buildCommand: "npm run build -- --browser chrome", outputDirectory: "dist/chrome" },
  edge: { enabled: false, installCommand: "", buildCommand: "", outputDirectory: "" },
  firefox: { enabled: false, installCommand: "npm install", buildCommand: "npm run build -- --browser firefox", outputDirectory: "dist/firefox" },
  safari: { enabled: false, installCommand: "", buildCommand: "", outputDirectory: "" },
};

type Call = { url: string; method: string; auth: string; body: any };

function tokenFor(workspace: string, project: string): string {
  return `${Buffer.from(JSON.stringify({ u: workspace, p: project })).toString("base64url")}.sig`;
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
const FINGERPRINT = sha256(`extension_settings.build\nsettingsDigest=${digestOf(MERGED)}`);

function projectOf(auth: string): { token: string; projectId: string } | null {
  const token = auth.replace(/^Bearer\s+/i, "");

  return Object.values(PROJECTS).find((entry) => entry.token === token) ?? null;
}

const saved: Record<string, string | undefined> = {};
let tmp: string;
let calls: Call[];
let mints: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function platform(url: string, init?: RequestInit): Response {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const method = String(init?.method ?? "GET").toUpperCase();
  const auth = String(headers.authorization ?? "");
  const entry: Call = { url, method, auth, body: init?.body ? JSON.parse(String(init.body)) : undefined };
  calls.push(entry);
  const who = projectOf(auth);
  const pathname = new URL(url).pathname;

  if (!who) return json({ message: "unknown token" }, 401);
  if (pathname === "/api/cli/whoami") return json({ login: "ok", live: true, projectId: who.projectId });
  if (pathname === `/api/projects/${who.projectId}/settings/build` && method === "GET") return json({ buildSettings: CURRENT });

  if (pathname === `/api/projects/${who.projectId}/settings/build` && method === "PUT") {
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
    const first = mints++ === 0;

    return json(
      {
        approvalId: first ? APPROVAL_ID : SECOND_ID,
        approvalUrl: first ? APPROVAL_URL : SECOND_URL,
        expiresAt: first ? "2026-10-23T01:04:44.000Z" : "2026-10-23T01:06:12.000Z",
        description: "Change the build settings of leon: firefox: enable",
      },
      201,
    );
  }

  if ((pathname === `/api/cli/approvals/${APPROVAL_ID}` || pathname === `/api/cli/approvals/${SECOND_ID}`) && method === "GET") {
    return who.projectId === PROJECTS.leon.projectId
      ? json({ status: "pending", fingerprint: FINGERPRINT, expiresAt: "2026-10-23T01:04:44.000Z", used: false })
      : json({ message: "Unknown approval", code: "APPROVAL_UNKNOWN" }, 404);
  }

  return json({ message: `unexpected ${method} ${pathname}` }, 500);
}

async function freshServer(): Promise<Client> {
  vi.resetModules();
  const { createServer } = await import("../index");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ features: ["local", "platform"], noShip: false }).connect(serverTransport);
  const client = new Client({ name: "approval-rebuild-probe", version: "0.0.0" });
  await client.connect(clientTransport);

  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });

  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

async function login(project: "leon" | "rebeccat"): Promise<void> {
  const { writeCredentials } = await import("../lib/credentials");
  writeCredentials({
    version: 1,
    token: PROJECTS[project].token,
    workspaceSlug: "acme",
    projectSlug: project,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    api: API,
  });
}

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-approval-rebuild-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  delete process.env.EXTENSION_DEV_PROJECT;
  delete process.env.EXTENSION_DEV_TOKEN;
  calls = [];
  mints = 0;
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

describe("an approval this machine minted is presented as the project that minted it, whatever became active since", () => {
  it("records the mint beside the login store, naming the project from the token's claims", async () => {
    if (process.platform === "win32") return;

    await login("leon");
    const client = await freshServer();
    const minted = await call(client, "extension_builds", { action: "configure", buildSettings: { firefox: { enabled: true } } });

    expect(minted.status).toBe("approval-required");
    expect(minted.value.approvalId).toBe(APPROVAL_ID);

    const { approvalRecordPath, mintedApproval } = await import("../lib/approval-record");

    expect(approvalRecordPath()).toBe(path.join(tmp, "extension-dev", "approvals.json"));
    expect(mintedApproval(undefined, APPROVAL_ID)).toMatchObject({
      approvalId: APPROVAL_ID,
      workspace: "acme",
      project: "leon",
      action: "extension_settings.build",
      fingerprint: FINGERPRINT,
      approvalUrl: APPROVAL_URL,
      expiresAt: "2026-10-23T01:04:44.000Z",
    });
  });

  it("answers pending with the approval URL after a rebuild and another chat's login, never unknown", async () => {
    if (process.platform === "win32") return;

    await login("leon");
    const minted = await call(await freshServer(), "extension_builds", { action: "configure", buildSettings: { firefox: { enabled: true } } });
    expect(minted.value.approvalId).toBe(APPROVAL_ID);

    await login("rebeccat");
    calls = [];
    const retried = await call(await freshServer(), "extension_builds", {
      action: "configure",
      buildSettings: { firefox: { enabled: true } },
      approvalId: APPROVAL_ID,
    });

    expect(retried.status).toBe("approval-pending");
    expect(retried.value).toMatchObject({ approvalId: APPROVAL_ID, approvalUrl: APPROVAL_URL, status: "pending" });
    expect(retried.error).toBeNull();
    expect(retried.hint).toContain(APPROVAL_URL);

    const lookup = calls.find((entry) => entry.url.endsWith(`/api/cli/approvals/${APPROVAL_ID}`));

    expect(lookup?.auth).toBe(`Bearer ${PROJECTS.leon.token}`);
    expect(calls.every((entry) => entry.auth === `Bearer ${PROJECTS.leon.token}`)).toBe(true);
    expect(calls.some((entry) => entry.method === "PUT")).toBe(false);
  });

  it("refuses a call that names another project for a minted id before the platform is asked", async () => {
    if (process.platform === "win32") return;

    await login("leon");
    await login("rebeccat");
    await call(await freshServer(), "extension_builds", { action: "configure", buildSettings: { firefox: { enabled: true } }, project: "acme/leon" });
    calls = [];

    const other = await call(await freshServer(), "extension_builds", {
      action: "configure",
      buildSettings: { firefox: { enabled: true } },
      project: "acme/rebeccat",
      approvalId: APPROVAL_ID,
    });

    expect(other.ok).toBe(false);
    expect(other.status).toBe("approval-rejected");
    expect(other.error.name).toBe("ApprovalOtherProject");
    expect(other.error.message).toContain("minted for acme/leon");
    expect(other.error.message).toContain("not acme/rebeccat");
    expect(other.hint).toContain('project: "acme/leon"');
    expect(other.value).toMatchObject({ approvalId: APPROVAL_ID, mintedFor: "acme/leon", named: "acme/rebeccat" });
    expect(calls).toEqual([]);

    const bySlug = await call(await freshServer(), "extension_builds", {
      action: "configure",
      buildSettings: { firefox: { enabled: true } },
      project: "leon",
      approvalId: APPROVAL_ID,
    });

    expect(bySlug.status).toBe("approval-pending");
  });

  it("names the minting project when the platform still answers unknown, and leaves an id it did not mint to the platform", async () => {
    if (process.platform === "win32") return;

    const { evaluateApproval } = await import("../lib/approval-gate");
    const { rememberMintedApproval } = await import("../lib/approval-record");
    const unknown = async () => json({ message: "Unknown approval", code: "APPROVAL_UNKNOWN" }, 404);
    const gate = {
      command: "extension_builds",
      action: "extension_settings.build",
      scope: { settingsDigest: digestOf(MERGED) },
      description: "Change the build settings of acme/leon.",
      approvalId: APPROVAL_ID,
      token: PROJECTS.leon.token,
      enabled: true,
      fetchImpl: unknown as unknown as typeof fetch,
    };

    const stranger = JSON.parse((await evaluateApproval(gate) as { envelope: string }).envelope);

    expect(stranger.error.name).toBe("ApprovalUnknown");
    expect(stranger.error.message).toContain("may have been minted for another server or project");
    expect(stranger.value.mintedFor).toBeUndefined();

    expect(
      rememberMintedApproval({
        token: PROJECTS.leon.token,
        approvalId: APPROVAL_ID,
        action: "extension_settings.build",
        fingerprint: FINGERPRINT,
        approvalUrl: APPROVAL_URL,
        expiresAt: "2026-10-23T01:04:44.000Z",
        now: Date.parse("2026-10-22T23:04:44.000Z"),
      }),
    ).toMatchObject({ workspace: "acme", project: "leon", mintedAt: "2026-10-22T23:04:44.000Z" });

    const ours = JSON.parse((await evaluateApproval(gate) as { envelope: string }).envelope);

    expect(ours.error.name).toBe("ApprovalUnknown");
    expect(ours.error.message).toContain("for acme/leon, the project this machine minted it for at 2026-10-22T23:04:44.000Z");
    expect(ours.value).toMatchObject({ mintedFor: "acme/leon", resolved: "acme/leon" });

    const other = JSON.parse((await evaluateApproval({ ...gate, token: PROJECTS.rebeccat.token }) as { envelope: string }).envelope);

    expect(other.error.name).toBe("ApprovalUnknown");
    expect(other.error.message).toContain("was minted for acme/leon and this call resolved acme/rebeccat");
    expect(other.error.message).not.toContain("another server");
    expect(other.value).toMatchObject({ mintedFor: "acme/leon", resolved: "acme/rebeccat" });
  });

  it("marks the older approval of the same act replaced by a fresh mint, and refuses the older id before the platform is asked", async () => {
    if (process.platform === "win32") return;

    await login("leon");
    const first = await call(await freshServer(), "extension_builds", { action: "configure", buildSettings: { firefox: { enabled: true } } });
    const second = await call(await freshServer(), "extension_builds", { action: "configure", buildSettings: { firefox: { enabled: true } } });

    expect(first.value.approvalId).toBe(APPROVAL_ID);
    expect(first.value.replaces).toBeUndefined();
    expect(second.value.approvalId).toBe(SECOND_ID);
    expect(second.value.replaces).toEqual([APPROVAL_ID]);

    const { mintedApproval } = await import("../lib/approval-record");

    expect(mintedApproval(undefined, APPROVAL_ID)?.replacedBy).toBe(SECOND_ID);
    expect(mintedApproval(undefined, SECOND_ID)).toMatchObject({ replaces: [APPROVAL_ID] });
    expect(mintedApproval(undefined, SECOND_ID)?.replacedBy).toBeUndefined();

    calls = [];
    const stale = await call(await freshServer(), "extension_builds", {
      action: "configure",
      buildSettings: { firefox: { enabled: true } },
      approvalId: APPROVAL_ID,
    });

    expect(stale.ok).toBe(false);
    expect(stale.status).toBe("approval-rejected");
    expect(stale.error.name).toBe("ApprovalReplaced");
    expect(stale.error.message).toContain(`was replaced by ${SECOND_ID}`);
    expect(stale.error.message).toContain(SECOND_URL);
    expect(stale.value).toMatchObject({ approvalId: APPROVAL_ID, replacedBy: SECOND_ID, approvalUrl: SECOND_URL });
    expect(stale.hint).toContain(`approvalId ${SECOND_ID}`);
    expect(calls.some((entry) => entry.url.includes("/api/cli/approvals/"))).toBe(false);
    expect(calls.some((entry) => entry.method === "PUT")).toBe(false);

    const current = await call(await freshServer(), "extension_builds", {
      action: "configure",
      buildSettings: { firefox: { enabled: true } },
      approvalId: SECOND_ID,
    });

    expect(current.status).toBe("approval-pending");
    expect(current.value.approvalUrl).toBe(SECOND_URL);
  });

  it("keeps a record for the platform's retention after its expiry and no longer, and skips a token without project claims", async () => {
    if (process.platform === "win32") return;

    const { APPROVAL_RECORD_RETENTION_SECONDS, mintedApproval, rememberMintedApproval } = await import("../lib/approval-record");
    const expiresAt = "2026-10-23T01:04:44.000Z";
    const record = rememberMintedApproval({
      token: PROJECTS.leon.token,
      approvalId: APPROVAL_ID,
      action: "extension_settings.build",
      fingerprint: FINGERPRINT,
      approvalUrl: APPROVAL_URL,
      expiresAt,
    });

    expect(record?.project).toBe("leon");

    const expired = Date.parse(expiresAt) + 1000;
    const retentionEnd = Date.parse(expiresAt) + APPROVAL_RECORD_RETENTION_SECONDS * 1000;

    expect(mintedApproval(undefined, APPROVAL_ID, expired)?.approvalId).toBe(APPROVAL_ID);
    expect(mintedApproval(undefined, APPROVAL_ID, retentionEnd - 1)?.approvalId).toBe(APPROVAL_ID);
    expect(mintedApproval(undefined, APPROVAL_ID, retentionEnd)).toBeNull();
    expect(mintedApproval("https://www.extension.dev", APPROVAL_ID)).toBeNull();

    expect(
      rememberMintedApproval({
        token: "opaque-oauth-token",
        approvalId: "apr_mqMmUULIB9kZoxQwAbr8Or3BcVCZR60r",
        action: "extension_release_promote",
        fingerprint: "ab2f",
        approvalUrl: APPROVAL_URL,
      }),
    ).toBeNull();

    expect(mintedApproval(undefined, "apr_mqMmUULIB9kZoxQwAbr8Or3BcVCZR60r")).toBeNull();
  });
});
