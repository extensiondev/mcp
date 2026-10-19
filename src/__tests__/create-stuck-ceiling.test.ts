import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { heldBatchesPath } from "../lib/held-batches";

const API = "https://api.test";
const GRANT = "provisioning-grant-stuck-in-creating";
const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];
const saved: Record<string, string | undefined> = {};
let tmp: string;

type Answer = { status: number; body: Record<string, unknown> } | "hang";
type Reads = Record<string, (authorization: string) => { status: number; body: unknown }>;

function creating(extra: Record<string, unknown> = {}): Answer {
  return {
    status: 202,
    body: { code: "CREATE_IN_PROGRESS", retryAfterSeconds: 10, message: "still", ...extra },
  };
}

function stubPlatform(grant: Record<string, unknown>, createPath: string, answers: Answer[], reads: Reads = {}) {
  const sent: Array<{ href: string; authorization: string }> = [];
  let redeemed = false;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      const headers = (init?.headers || {}) as Record<string, string>;
      const authorization = String(headers.authorization || "");
      sent.push({ href, authorization });

      if (href.endsWith("/api/cli/login/config")) {
        return new Response(JSON.stringify({ verificationUri: "https://extension.dev/device" }));
      }

      if (href.endsWith("/api/cli/device/token")) {
        if (redeemed) return new Response(JSON.stringify({ error: "expired_token" }), { status: 400 });

        redeemed = true;

        return new Response(JSON.stringify({ token: GRANT, expiresAt: 4_000_000_000, ...grant }));
      }

      if (href.endsWith(createPath)) {
        const answer = answers.length > 1 ? answers.shift() : answers[0];

        if (!answer || answer === "hang") {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          });
        }

        return new Response(JSON.stringify(answer.body), { status: answer.status });
      }

      const pathAndQuery = href.slice(API.length);
      const read = reads[pathAndQuery];

      if (read) {
        const answer = read(authorization);

        return new Response(JSON.stringify(answer.body), { status: answer.status });
      }

      throw new Error(`Unexpected fetch: ${href}`);
    }),
  );

  return {
    to: (suffix: string) => sent.filter((entry) => entry.href.split("?")[0]!.endsWith(suffix)),
  };
}

async function freshTools() {
  vi.resetModules();

  return {
    projectCreate: await import("../tools/project-create"),
    workspaceCreate: await import("../tools/workspace-create"),
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-create-stuck-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-19T13:42:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

const PROJECT_GRANT = { workspaceSlug: "acme", projectSlug: "widget", tokenKind: "provisioning" };
const PROJECT_ARGS = { project: "acme/widget", repo: "octo/widget", deviceCode: "dev-code" };

async function abandonFirstProjectCall(tools: Awaited<ReturnType<typeof freshTools>>) {
  const pending = tools.projectCreate.handler(PROJECT_ARGS);
  await vi.advanceTimersByTimeAsync(45_000);

  return JSON.parse(await pending);
}

describe("a create the platform keeps reporting as creating", () => {
  it("the abandoned answer says the platform may still be finishing and that creating carries its start time", async () => {
    stubPlatform(PROJECT_GRANT, "/api/cli/projects/create", ["hang"]);
    const tools = await freshTools();
    const unconfirmed = await abandonFirstProjectCall(tools);

    expect(unconfirmed.status).toBe("create-unconfirmed");
    expect(unconfirmed.hint).toContain("may still be finishing");
    expect(unconfirmed.hint).toContain("without a second approval");
    expect(unconfirmed.hint).toContain("when the platform started");
  });

  it("extension_project_create answers create-stuck once the platform's ageSeconds passes six minutes", async () => {
    stubPlatform(PROJECT_GRANT, "/api/cli/projects/create", [
      "hang",
      creating({ startedAt: Date.parse("2026-10-19T13:41:16.000Z"), ageSeconds: 90 }),
      creating({ startedAt: Date.parse("2026-10-19T13:41:16.000Z"), ageSeconds: 420 }),
    ]);

    const tools = await freshTools();
    await abandonFirstProjectCall(tools);

    const early = JSON.parse(await tools.projectCreate.handler(PROJECT_ARGS));

    expect(early.ok).toBe(true);
    expect(early.status).toBe("creating");
    expect(early.value.creatingForSeconds).toBe(90);
    expect(early.value.startedAt).toBe("2026-10-19T13:41:16.000Z");

    const stuck = JSON.parse(await tools.projectCreate.handler(PROJECT_ARGS));

    expect(stuck.ok).toBe(false);
    expect(stuck.status).toBe("create-stuck");
    expect(stuck.error.code).toBe("E_CREATE_STUCK");
    expect(stuck.error.message).toContain("7 min");
    expect(stuck.error.message).toContain("may already exist");
    expect(stuck.value).toMatchObject({
      project: "acme/widget",
      retryAfterSeconds: 10,
      deviceCode: "dev-code",
      creatingForSeconds: 420,
    });

    expect(stuck.value.nextSteps[0]).toContain("extension_auth (action: login, project: 'acme/widget')");
    expect(stuck.value.nextSteps[1]).toContain("/acme/widget");
    expect(stuck.hint).toContain("extension_auth");
    expect(fs.existsSync(heldBatchesPath())).toBe(true);
    expect(JSON.stringify([early, stuck])).not.toContain(GRANT);
  });

  it("extension_project_create counts its own time from the first creating when the platform sends no age", async () => {
    stubPlatform(PROJECT_GRANT, "/api/cli/projects/create", ["hang", creating()]);
    const tools = await freshTools();
    await abandonFirstProjectCall(tools);

    const first = JSON.parse(await tools.projectCreate.handler(PROJECT_ARGS));

    expect(first.status).toBe("creating");

    vi.setSystemTime(Date.now() + 5 * 60_000);
    const restarted = await freshTools();
    const stillCreating = JSON.parse(await restarted.projectCreate.handler(PROJECT_ARGS));

    expect(stillCreating.status).toBe("creating");

    vi.setSystemTime(Date.now() + 2 * 60_000);
    const stuck = JSON.parse(await restarted.projectCreate.handler(PROJECT_ARGS));

    expect(stuck.status).toBe("create-stuck");
    expect(stuck.error.code).toBe("E_CREATE_STUCK");
    expect(stuck.value.creatingForSeconds).toBe(420);
  });

  it("extension_project_create answers created when a stored workspace login lists the project although the platform says creating", async () => {
    writeCredentials({
      version: 1,
      token: "token-for-acme-other",
      workspaceSlug: "acme",
      projectSlug: "other",
      expiresAt: 4_000_000_000,
      api: API,
    });

    const platform = stubPlatform(PROJECT_GRANT, "/api/cli/projects/create", ["hang", creating()], {
      "/api/cli/whoami": () => ({
        status: 200,
        body: { login: "acme/other", live: true, projectId: "prj_other", workspaceSlug: "acme", projectSlug: "other" },
      }),
      "/api/projects?workspace=acme": (authorization) =>
        authorization === "Bearer token-for-acme-other"
          ? { status: 200, body: { projects: [{ id: "prj_other", slug: "other" }, { id: "prj_widget", slug: "widget" }] } }
          : { status: 401, body: { message: "no" } },
    });
    const tools = await freshTools();
    await abandonFirstProjectCall(tools);

    const out = JSON.parse(await tools.projectCreate.handler(PROJECT_ARGS));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("created");
    expect(out.value).toMatchObject({ workspaceSlug: "acme", projectSlug: "widget", projectId: "prj_widget" });
    expect(out.value.nextSteps[0]).toContain("extension_auth (action: login, project: 'acme/widget')");
    expect(platform.to("/api/projects")).toHaveLength(1);
    expect(fs.existsSync(heldBatchesPath())).toBe(false);
    expect(JSON.stringify(out)).not.toContain(GRANT);
    expect(JSON.stringify(out)).not.toContain("token-for-acme-other");
  });

  it("extension_project_create answers created when the project's own stored login resolves on the server", async () => {
    writeCredentials({
      version: 1,
      token: "token-for-acme-widget",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: 4_000_000_000,
      api: API,
    });

    stubPlatform(PROJECT_GRANT, "/api/cli/projects/create", ["hang", creating({ ageSeconds: 500 })], {
      "/api/cli/whoami": (authorization) =>
        authorization === "Bearer token-for-acme-widget"
          ? { status: 200, body: { login: "acme/widget", live: true, projectId: "prj_widget" } }
          : { status: 401, body: { message: "no" } },
    });

    const tools = await freshTools();
    await abandonFirstProjectCall(tools);

    const out = JSON.parse(await tools.projectCreate.handler(PROJECT_ARGS));

    expect(out.status).toBe("created");
    expect(out.value).toMatchObject({ projectSlug: "widget", projectId: "prj_widget" });
    expect(fs.existsSync(heldBatchesPath())).toBe(false);
  });

  it("extension_workspace_create answers create-stuck once the platform's ageSeconds passes six minutes", async () => {
    stubPlatform({ workspaceSlug: "acme", tokenKind: "workspace-provisioning" }, "/api/cli/workspaces/create", [
      "hang",
      creating({ ageSeconds: 30 }),
      creating({ ageSeconds: 400 }),
    ]);

    const args = { workspace: "acme", deviceCode: "dev-code" };
    const tools = await freshTools();
    const pending = tools.workspaceCreate.handler(args);
    await vi.advanceTimersByTimeAsync(45_000);
    const unconfirmed = JSON.parse(await pending);

    expect(unconfirmed.hint).toContain("when the platform started");

    const early = JSON.parse(await tools.workspaceCreate.handler(args));

    expect(early.status).toBe("creating");
    expect(early.value.creatingForSeconds).toBe(30);

    const stuck = JSON.parse(await tools.workspaceCreate.handler(args));

    expect(stuck.ok).toBe(false);
    expect(stuck.status).toBe("create-stuck");
    expect(stuck.error.code).toBe("E_CREATE_STUCK");
    expect(stuck.error.message).toContain("may already exist");
    expect(stuck.value).toMatchObject({ workspace: "acme", retryAfterSeconds: 10, deviceCode: "dev-code" });
    expect(stuck.hint).toContain("extension_project_create");
    expect(fs.existsSync(heldBatchesPath())).toBe(true);
  });
});
