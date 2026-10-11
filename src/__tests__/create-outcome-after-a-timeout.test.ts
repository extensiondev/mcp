import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { heldBatchesPath } from "../lib/held-batches";

const API = "https://api.test";
const GRANT = "provisioning-grant-held-for-the-outcome";
const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];
const saved: Record<string, string | undefined> = {};
let tmp: string;

type Answer = { status: number; body: Record<string, unknown> } | "hang";

function stubPlatform(grant: Record<string, unknown>, createPath: string, answers: Answer[]) {
  const sent: Array<{ href: string; authorization: string }> = [];
  let redeemed = false;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      const headers = (init?.headers || {}) as Record<string, string>;
      sent.push({ href, authorization: String(headers.authorization || "") });

      if (href.endsWith("/api/cli/login/config")) {
        return new Response(JSON.stringify({ verificationUri: "https://extension.dev/device" }));
      }

      if (href.endsWith("/api/cli/device/token")) {
        if (redeemed) {
          return new Response(JSON.stringify({ error: "expired_token" }), { status: 400 });
        }

        redeemed = true;

        return new Response(JSON.stringify({ token: GRANT, expiresAt: 4_000_000_000, ...grant }));
      }

      if (href.endsWith(createPath)) {
        const answer = answers.shift();

        if (!answer || answer === "hang") {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          });
        }

        return new Response(JSON.stringify(answer.body), { status: answer.status });
      }

      throw new Error(`Unexpected fetch: ${href}`);
    }),
  );

  return {
    to: (suffix: string) => sent.filter((entry) => entry.href.endsWith(suffix)),
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-create-outcome-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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

const CREATED = {
  success: true,
  projectId: "prj_made",
  projectSlug: "widget",
  workspaceSlug: "acme",
  initialBuild: { dispatched: true },
  replayed: true,
};

describe("a create the platform finished after the call gave up", () => {
  it("extension_project_create reports it created on the next call with the same deviceCode, with no second approval", async () => {
    const platform = stubPlatform(
      { workspaceSlug: "acme", projectSlug: "widget", tokenKind: "provisioning" },
      "/api/cli/projects/create",
      ["hang", { status: 200, body: CREATED }],
    );
    const args = { project: "acme/widget", repo: "octo/widget", deviceCode: "dev-code" };
    const first = await freshTools();
    const pending = first.projectCreate.handler(args);
    await vi.advanceTimersByTimeAsync(45_000);
    const unconfirmed = JSON.parse(await pending);

    expect(unconfirmed.status).toBe("create-unconfirmed");
    expect(unconfirmed.value.deviceCode).toBe("dev-code");
    expect(unconfirmed.hint).toContain("same deviceCode");
    expect(fs.statSync(heldBatchesPath()).mode & 0o777).toBe(0o600);

    const restarted = await freshTools();
    const out = JSON.parse(await restarted.projectCreate.handler(args));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("created");
    expect(out.value).toMatchObject({ workspaceSlug: "acme", projectSlug: "widget", projectId: "prj_made" });
    expect(out.hint).toContain("nothing was created twice");
    expect(platform.to("/api/cli/device/token")).toHaveLength(1);
    expect(platform.to("/api/cli/projects/create").map((entry) => entry.authorization)).toEqual([
      `Bearer ${GRANT}`,
      `Bearer ${GRANT}`,
    ]);

    expect(fs.existsSync(heldBatchesPath())).toBe(false);
    expect(JSON.stringify([unconfirmed, out])).not.toContain(GRANT);
  });

  it("extension_project_create answers creating while the platform is still on it, then the outcome", async () => {
    stubPlatform(
      { workspaceSlug: "acme", projectSlug: "widget", tokenKind: "provisioning" },
      "/api/cli/projects/create",
      [
        "hang",
        { status: 202, body: { code: "CREATE_IN_PROGRESS", retryAfterSeconds: 10, message: "still" } },
        { status: 409, body: { code: "PROJECT_EXISTS", message: "Project 'acme/widget' already exists." } },
      ],
    );

    const args = { project: "acme/widget", repo: "octo/widget", deviceCode: "dev-code" };
    const tools = await freshTools();
    const pending = tools.projectCreate.handler(args);
    await vi.advanceTimersByTimeAsync(45_000);
    await pending;

    const creating = JSON.parse(await tools.projectCreate.handler(args));

    expect(creating.ok).toBe(true);
    expect(creating.status).toBe("creating");
    expect(creating.value).toMatchObject({ project: "acme/widget", deviceCode: "dev-code", retryAfterSeconds: 10 });
    expect(fs.existsSync(heldBatchesPath())).toBe(true);

    const exists = JSON.parse(await tools.projectCreate.handler(args));

    expect(exists.status).toBe("project-exists");
    expect(fs.existsSync(heldBatchesPath())).toBe(false);
  });

  it("extension_workspace_create reports it created on the next call with the same deviceCode, with no second approval", async () => {
    const platform = stubPlatform(
      { workspaceSlug: "acme", tokenKind: "workspace-provisioning" },
      "/api/cli/workspaces/create",
      [
        "hang",
        {
          status: 201,
          body: {
            id: "ws_made",
            slug: "acme",
            displayName: "Acme",
            createdAt: "2026-10-11T00:00:00.000Z",
            ownerGithubLogin: "octocat",
            replayed: true,
          },
        },
      ],
    );
    const args = { workspace: "acme", deviceCode: "dev-code" };
    const first = await freshTools();
    const pending = first.workspaceCreate.handler(args);
    await vi.advanceTimersByTimeAsync(45_000);
    const unconfirmed = JSON.parse(await pending);

    expect(unconfirmed.status).toBe("create-unconfirmed");
    expect(unconfirmed.value.deviceCode).toBe("dev-code");

    const restarted = await freshTools();
    const out = JSON.parse(await restarted.workspaceCreate.handler(args));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("created");
    expect(out.value).toMatchObject({ workspaceSlug: "acme", workspaceId: "ws_made", ownerGithubLogin: "octocat" });
    expect(platform.to("/api/cli/device/token")).toHaveLength(1);
    expect(platform.to("/api/cli/workspaces/create")).toHaveLength(2);
    expect(fs.existsSync(heldBatchesPath())).toBe(false);
    expect(JSON.stringify([unconfirmed, out])).not.toContain(GRANT);
  });
});
