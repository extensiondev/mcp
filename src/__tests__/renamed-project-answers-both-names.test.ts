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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* @invariant Each cell re-imports the server after vi.resetModules, which only
 * re-evaluates it. This import pays the cold transform of the whole graph once,
 * at collection, so no cell's budget is spent compiling the server. */
import "../index";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_a017a32f";
const OTHER_ID = "prj_5c3e9b10";
const APPROVAL_ID = "apr_J3pJzcFuh6UWFwP_AMwl_IZ085Ookc_R";
const FRESH_ID = "apr_rS0P0RbO3UsOyG3zy4DN4NQHxlixx7Kt";
const KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];
const LOGIN_MOVED = "The project acme/leon is now acme/lion; its login moved with it, pass project: 'acme/lion' from now on.";
const saved: Record<string, string | undefined> = {};
let tmp: string;
let approvalReads: string[];

function tokenFor(workspace: string, project: string): string {
  return `${Buffer.from(JSON.stringify({ u: workspace, p: project })).toString("base64url")}.sig`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function platform(url: string): Response {
  const pathname = new URL(url).pathname;

  if (pathname === "/api/cli/whoami") {
    return json({ login: "acme/lion", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "lion" });
  }

  if (pathname === `/api/projects/${PROJECT_ID}/builds`) return json({ items: [] });

  if (pathname === `/api/cli/approvals/${APPROVAL_ID}`) {
    approvalReads.push(pathname);

    return json({ approvalId: APPROVAL_ID, status: "approved", used: false });
  }

  return json({ message: `unexpected ${pathname}` }, 500);
}

async function freshServer(project?: string): Promise<Client> {
  vi.resetModules();
  const { createServer } = await import("../index");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ features: ["local", "platform"], noShip: false, ...(project ? { project } : {}) }).connect(serverTransport);
  const client = new Client({ name: "renamed-project-probe", version: "0.0.0" });
  await client.connect(clientTransport);

  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });

  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

async function loginThenRename(projectId = PROJECT_ID): Promise<void> {
  const { moveLogin, writeCredentials } = await import("../lib/credentials");
  writeCredentials({
    version: 1,
    token: tokenFor("acme", "leon"),
    workspaceSlug: "acme",
    projectSlug: "leon",
    ...(projectId ? { projectId } : {}),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    api: API,
  });

  moveLogin({ workspaceSlug: "acme", fromProjectSlug: "leon", toProjectSlug: "lion", api: API, ...(projectId ? { projectId } : {}) });
}

async function otherLogin(): Promise<void> {
  const { writeCredentials } = await import("../lib/credentials");
  writeCredentials({
    version: 1,
    token: tokenFor("acme", "rebeccat"),
    workspaceSlug: "acme",
    projectSlug: "rebeccat",
    projectId: OTHER_ID,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    api: API,
  });
}

async function mint(approvalId = APPROVAL_ID, action = "extension_submit.version") {
  const { rememberMintedApproval } = await import("../lib/approval-record");

  return rememberMintedApproval({
    api: API,
    token: tokenFor("acme", "leon"),
    approvalId,
    action,
    fingerprint: "f".repeat(64),
    approvalUrl: `${API}/device/approve/${approvalId}`,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
}

async function bind(args: Record<string, unknown>) {
  const { bindApprovalProject } = await import("../lib/approval-record");

  return bindApprovalProject("extension_submit", { approvalId: APPROVAL_ID, api: API, ...args });
}

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-both-names-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  delete process.env.EXTENSION_DEV_PROJECT;
  delete process.env.EXTENSION_DEV_TOKEN;
  approvalReads = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any) => platform(String(url))));
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

describe("a login stored under the old slug answers reads under both names", () => {
  it("lists builds under the new slug and under the old slug, the old one with the move said each time", async () => {
    if (process.platform === "win32") return;

    await loginThenRename();
    const client = await freshServer();

    const underNew = await call(client, "extension_builds", { action: "list", limit: 2, project: "acme/lion" });
    expect(underNew.status).toBe("listed");
    expect(underNew.warnings ?? []).not.toContain(LOGIN_MOVED);

    for (let read = 0; read < 3; read += 1) {
      const underOld = await call(client, "extension_builds", { action: "list", limit: 2, project: "acme/leon" });

      expect(underOld.ok).toBe(true);
      expect(underOld.status).toBe("listed");
      expect(underOld.status).not.toBe("auth-required");
      expect(underOld.value.project).toBe("acme/lion");
      expect(underOld.warnings).toContain(LOGIN_MOVED);
    }

    const { readCredentials } = await import("../lib/credentials");
    expect(readCredentials({ project: "acme/leon", api: API })).toMatchObject({ projectSlug: "lion", movedFrom: "acme/leon" });
  });

  it("resolves the old slug, the new slug and the bare slugs to one project with its current name", async () => {
    await loginThenRename();
    const { currentProjectName, resolveProjectIdentity, sameStoredProject } = await import("../lib/project-identity");

    expect(resolveProjectIdentity(API, "acme/leon")).toEqual({ current: "acme/lion", projectId: PROJECT_ID, movedFrom: "acme/leon" });
    expect(resolveProjectIdentity(API, "acme/lion")).toEqual({ current: "acme/lion", projectId: PROJECT_ID, movedFrom: null });
    expect(currentProjectName(API, "leon")).toBe("acme/lion");
    expect(currentProjectName(API, "acme/ghost")).toBe("acme/ghost");
    expect(sameStoredProject(API, "acme/leon", "acme/lion")).toBe(true);
    expect(sameStoredProject(API, "lion", "acme/leon")).toBe(true);
    expect(sameStoredProject(API, "acme/leon", "acme/ghost")).toBe(false);
    expect(resolveProjectIdentity(API, "")).toBeNull();
  });
});

describe("an approval minted under the new slug binds to the project under either name", () => {
  it("records the project by its current slug and id, not by the token's old claim", async () => {
    await loginThenRename();

    expect(await mint()).toMatchObject({ workspace: "acme", project: "lion", projectId: PROJECT_ID });
  });

  it("accepts the retry under the new slug with no note, the old slug as the new one with a note, and a bare slug", async () => {
    await loginThenRename();
    await mint();
    const { movedNameNote } = await import("../lib/project-identity");

    const underNew = await bind({ project: "acme/lion" });
    expect(underNew).toEqual({ args: { approvalId: APPROVAL_ID, api: API, project: "acme/lion" } });

    const underOld = await bind({ project: "acme/leon" });
    expect(underOld).toEqual({ args: { approvalId: APPROVAL_ID, api: API, project: "acme/lion" }, note: movedNameNote("acme/leon", "acme/lion") });
    expect("note" in underOld && underOld.note).toBe("acme/leon is now acme/lion; this call was made as acme/lion, pass project: 'acme/lion' from now on.");

    const bare = await bind({ project: "lion" });
    expect("refused" in bare).toBe(false);

    const unnamed = await bind({});
    expect(unnamed).toEqual({ args: { approvalId: APPROVAL_ID, api: API, project: "acme/lion" } });
  });

  it("binds under either name when the stored login carries no project id at all", async () => {
    await loginThenRename("");
    const minted = await mint();

    expect(minted).toMatchObject({ workspace: "acme", project: "lion" });
    expect(minted).not.toHaveProperty("projectId");
    expect("refused" in (await bind({ project: "acme/lion" }))).toBe(false);
    expect("refused" in (await bind({ project: "acme/leon" }))).toBe(false);
  });

  it("still refuses a project this machine resolves to another id, or to none", async () => {
    await loginThenRename();
    await otherLogin();
    await mint();

    const other = await bind({ project: "acme/rebeccat" });
    expect("refused" in other).toBe(true);
    const out = JSON.parse("refused" in other ? other.refused : "{}");
    expect(out.error.name).toBe("ApprovalOtherProject");
    expect(out.value).toMatchObject({ mintedFor: "acme/lion", named: "acme/rebeccat" });

    expect("refused" in (await bind({ project: "acme/ghost" }))).toBe(true);
  });

  it("answers an approval status read under the new slug and under the old one", async () => {
    if (process.platform === "win32") return;

    await loginThenRename();
    await mint();
    const client = await freshServer();

    const underNew = await call(client, "extension_approvals", { action: "status", approvalId: APPROVAL_ID, project: "acme/lion" });
    expect(underNew.ok).toBe(true);
    expect(underNew.status).toBe("approved-unused");

    const underOld = await call(client, "extension_approvals", { action: "status", approvalId: APPROVAL_ID, project: "acme/leon" });
    expect(underOld.ok).toBe(true);
    expect(underOld.status).toBe("approved-unused");
    expect(underOld.value.note).toContain("acme/leon is now acme/lion");
    expect(approvalReads).toHaveLength(2);
  });

  it("marks a record that kept the old slug replaced by a fresh mint of the same act under the new one", async () => {
    const { writeCredentials } = await import("../lib/credentials");
    writeCredentials({
      version: 1,
      token: tokenFor("acme", "leon"),
      workspaceSlug: "acme",
      projectSlug: "leon",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });

    const older = await mint();
    expect(older).toMatchObject({ project: "leon" });
    expect(older).not.toHaveProperty("projectId");

    const { moveLogin } = await import("../lib/credentials");
    moveLogin({ workspaceSlug: "acme", fromProjectSlug: "leon", toProjectSlug: "lion", api: API });
    const fresh = await mint(FRESH_ID);

    expect(fresh).toMatchObject({ project: "lion", replaces: [APPROVAL_ID] });
  });

  it("picks the live login for a record that kept the old slug and carries no id", async () => {
    await loginThenRename("");
    const { storedLoginFor } = await import("../lib/approval-login");

    const login = storedLoginFor({ workspace: "acme", project: "leon" }, API);

    expect(login?.projectSlug).toBe("lion");
    expect(login?.token).toBe(tokenFor("acme", "leon"));
  });

  it("names the current slug when the platform forgot an approval minted after the rename", async () => {
    await loginThenRename();
    await mint();
    const { verifyApproval } = await import("../lib/approval-verify");
    const { mintedApproval } = await import("../lib/approval-record");
    const forgot = vi.fn(async () => new Response(JSON.stringify({ code: "APPROVAL_UNKNOWN", message: "Unknown approval" }), { status: 404 }));

    const result = await verifyApproval({
      base: API,
      fingerprint: "f".repeat(64),
      input: {
        command: "extension_submit",
        action: "extension_submit.version",
        scope: {},
        description: "Send build abc to chrome.",
        approvalId: APPROVAL_ID,
        token: tokenFor("acme", "leon"),
        api: API,
      },
      doFetch: forgot as unknown as typeof fetch,
      minted: mintedApproval(API, APPROVAL_ID),
    });

    const out = JSON.parse(result.blocked ? result.envelope : "{}");
    expect(out.error.name).toBe("ApprovalUnknown");
    expect(out.error.message).toContain("for acme/lion, the project this machine minted it for");
    expect(out.error.message).not.toContain("(now");
    expect(out.error.message).not.toContain("this call resolved");
  });
});

describe("the approval answer points at the project's current slug", () => {
  it("records the current slug from the login the token belongs to when the old alias is gone", async () => {
    const { writeCredentials } = await import("../lib/credentials");
    writeCredentials({
      version: 1,
      token: tokenFor("acme", "leon"),
      workspaceSlug: "acme",
      projectSlug: "lion",
      projectId: PROJECT_ID,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });

    expect(await mint()).toMatchObject({ workspace: "acme", project: "lion", projectId: PROJECT_ID });
    expect(await bind({ project: "acme/lion" })).toEqual({ args: { approvalId: APPROVAL_ID, api: API, project: "acme/lion" } });
    expect(await bind({})).toEqual({ args: { approvalId: APPROVAL_ID, api: API, project: "acme/lion" } });
  });

  it("names the current slug in the checkUrl of an approval asked under the old name or none", async () => {
    await loginThenRename();
    const { trackFields } = await import("../lib/track-url");
    const value = { approvalUrl: `${API}/device/approve/${APPROVAL_ID}` };

    for (const args of [{ action: "submit", project: "acme/leon", api: API }, { action: "submit", project: "acme/lion", api: API }]) {
      const fields = trackFields("extension_submit", { args, status: "approval-required", value });

      expect(fields?.trackUrl).toBe(value.approvalUrl);
      expect(fields?.checkUrl).toContain("/lion");
      expect(fields?.checkUrl).not.toContain("/leon");
    }
  });

  it("says the current slug in the login sentence of a token minted under the old one", async () => {
    await loginThenRename();
    const { loginRefusedBeforeApproval } = await import("../lib/approval-login");

    const out = JSON.parse(
      loginRefusedBeforeApproval(
        { command: "extension_submit", action: "extension_submit.version", description: "Send build abc to chrome.", token: tokenFor("acme", "leon"), api: API },
        401,
        "Token revoked",
      ).envelope,
    );

    expect(JSON.stringify(out)).toContain("acme/lion");
    expect(JSON.stringify(out)).not.toContain("acme/leon");
  });
});

describe("a pinned server takes the old name of its pinned project", () => {
  it("accepts a call naming the slug the pinned project left", async () => {
    await loginThenRename();
    const { pinProjectArgs } = await import("../lib/tool-policy");
    const schema = { type: "object", properties: { project: { type: "string" } } };
    const options = { project: "acme/lion", features: ["local", "platform"] } as any;

    expect(pinProjectArgs("extension_builds", { project: "acme/leon", api: API }, schema, options)).toEqual({
      args: { project: "acme/leon", api: API },
    });

    expect(pinProjectArgs("extension_builds", { projects: ["acme/leon", "acme/lion"], api: API }, schema, options)).toEqual({
      args: { projects: ["acme/leon", "acme/lion"], api: API },
    });

    const other = pinProjectArgs("extension_builds", { project: "acme/rebeccat", api: API }, schema, options);
    expect("refused" in other).toBe(true);
  });
});
