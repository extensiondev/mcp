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

const API = "http://localhost:3100";
const PROJECT_ID = "prj_a017a32f";
const KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];
const SENTENCE = "acme/leon is now acme/lion; this server follows the new name.";
const MOVED_BODY = {
  code: "PROJECT_MOVED",
  message: "The project acme/leon is now acme/lion.",
  projectId: PROJECT_ID,
  workspaceSlug: "acme",
  projectSlug: "lion",
  previousProjectSlug: "leon",
};
const saved: Record<string, string | undefined> = {};
let tmp: string;
let buildsReads: string[];
let movesAnswered: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function platform(url: string): Response {
  const pathname = new URL(url).pathname;

  if (pathname === "/api/cli/whoami") {
    const slug = buildsReads.length ? "lion" : "leon";

    return json({ login: `acme/${slug}`, live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: slug });
  }

  if (pathname === `/api/projects/${PROJECT_ID}/builds`) {
    buildsReads.push(pathname);

    if (buildsReads.length <= movesAnswered) return json(MOVED_BODY, 404);

    return json({ items: [] });
  }

  return json({ message: `unexpected ${pathname}` }, 500);
}

async function freshServer(project?: string): Promise<Client> {
  vi.resetModules();
  const { createServer } = await import("../index");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ features: ["local", "platform"], noShip: false, ...(project ? { project } : {}) }).connect(serverTransport);
  const client = new Client({ name: "project-move-probe", version: "0.0.0" });
  await client.connect(clientTransport);

  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });

  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

async function login(): Promise<void> {
  const { writeCredentials } = await import("../lib/credentials");
  writeCredentials({
    version: 1,
    token: `${Buffer.from(JSON.stringify({ u: "acme", p: "leon" })).toString("base64url")}.sig`,
    workspaceSlug: "acme",
    projectSlug: "leon",
    projectId: PROJECT_ID,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    api: API,
  });
}

async function created(...refs: string[]): Promise<void> {
  const { rememberCreatedProject } = await import("../lib/created-projects");
  for (const ref of refs) rememberCreatedProject(API, ref);
}

async function createdRefs(): Promise<string[]> {
  const { createdProjectsPath } = await import("../lib/created-projects");
  const file = JSON.parse(fs.readFileSync(createdProjectsPath(), "utf8")) as Record<string, Record<string, number>>;

  return Object.values(file).flatMap((onServer) => Object.keys(onServer)).sort();
}

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-project-move-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  delete process.env.EXTENSION_DEV_PROJECT;
  delete process.env.EXTENSION_DEV_TOKEN;
  buildsReads = [];
  movesAnswered = 1;
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

describe("a PROJECT_MOVED answer is followed once by the records this server keeps", () => {
  it("rewrites the created record and the pin, retries once under the new slug, and says so once", async () => {
    if (process.platform === "win32") return;

    await login();
    await created("acme/leon", "acme/other");
    process.env.EXTENSION_DEV_PROJECT = "acme/leon";
    const client = await freshServer("acme/leon");

    const out = await call(client, "extension_builds", { action: "list", limit: 2 });

    expect(out.ok).toBe(true);
    expect(out.status).toBe("listed");
    expect(out.value.project).toBe("acme/lion");
    expect(out.warnings).toContain(SENTENCE);
    expect(out.warnings.filter((line: string) => line === SENTENCE)).toHaveLength(1);
    expect(buildsReads).toHaveLength(2);
    expect(await createdRefs()).toEqual(["acme/lion", "acme/other"]);
    expect(process.env.EXTENSION_DEV_PROJECT).toBe("acme/lion");

    const { listCredentials } = await import("../lib/credentials");
    expect(listCredentials().map((entry) => `${entry.workspaceSlug}/${entry.projectSlug}`)).toEqual(["acme/lion"]);

    const pinnedNew = await call(client, "extension_builds", { action: "list", limit: 2, project: "acme/lion" });
    expect(pinnedNew.status).toBe("listed");
  });

  it("does not follow a second move answered in the same call", async () => {
    if (process.platform === "win32") return;

    await login();
    await created("acme/leon");
    movesAnswered = 2;

    const out = await call(await freshServer(), "extension_builds", { action: "list", limit: 2 });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("moved");
    expect(out.error.name).toBe("BuildsProjectMoved");
    expect(buildsReads).toHaveLength(2);
    expect(await createdRefs()).toEqual(["acme/lion"]);
  });

  it("rewrites nothing when the move names a project this server never recorded or pinned", async () => {
    if (process.platform === "win32") return;

    await login();
    await created("acme/other");
    process.env.EXTENSION_DEV_PROJECT = "acme/other";

    const { followProjectMove } = await import("../lib/project-move");
    const followed = followProjectMove({ apiBase: API, move: { from: "acme/leon", to: "acme/lion", projectId: PROJECT_ID } });

    expect(followed).toEqual([]);
    expect(await createdRefs()).toEqual(["acme/other"]);
    expect(process.env.EXTENSION_DEV_PROJECT).toBe("acme/other");
  });

  it("reads the move from the body www sends and ignores one that names no previous slug", async () => {
    const { readProjectMove, movedAnswer } = await import("../lib/project-move");
    const { envelope } = await import("../lib/envelope");

    expect(readProjectMove(MOVED_BODY)).toEqual({ from: "acme/leon", to: "acme/lion", projectId: PROJECT_ID });
    expect(readProjectMove({ ...MOVED_BODY, previousProjectSlug: undefined }, "acme/leon")).toEqual({ from: "acme/leon", to: "acme/lion", projectId: PROJECT_ID });
    expect(readProjectMove({ ...MOVED_BODY, previousProjectSlug: undefined })).toBeNull();
    expect(readProjectMove({ ...MOVED_BODY, projectSlug: "leon" })).toBeNull();

    const moved = envelope({ ok: false, command: "extension_builds", status: "moved", value: { moved: { from: "acme/leon", to: "acme/lion", projectId: PROJECT_ID } }, error: { code: "E_PLATFORM", message: "moved" } });
    expect(movedAnswer(moved)).toEqual({ from: "acme/leon", to: "acme/lion", projectId: PROJECT_ID });
    expect(movedAnswer(envelope({ ok: true, command: "extension_builds", status: "listed", value: { moved: { from: "a/b", to: "a/c" } } }))).toBeNull();
    expect(movedAnswer(envelope({ ok: false, command: "extension_builds", status: "moved", value: {}, error: { code: "E_PLATFORM", message: "moved" } }))).toBeNull();
  });
});
