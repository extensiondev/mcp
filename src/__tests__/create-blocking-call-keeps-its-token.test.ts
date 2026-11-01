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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readCredentials } from "../lib/credentials";
import { handler as createProject } from "../tools/project-create";

const API = "https://api.test";
const PROJECT = "acme/widget";
const FUTURE = Math.floor(Date.now() / 1000) + 900;
const GRANT = "provisioning-grant-for-the-long-call";

type CreateAnswer = { afterMs: number; status: number; body: Record<string, unknown> } | "hang";

const CREATED = {
  success: true,
  projectId: "prj_made",
  projectSlug: "widget",
  workspaceSlug: "acme",
  initialBuild: { dispatched: true },
};

function platform(pendingPolls: number, answers: CreateAnswer[]) {
  let polls = 0;
  const creates: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

      if (href.endsWith("/api/cli/login/config")) {
        return reply(200, { deviceCodeUrl: "/api/cli/device/code", deviceTokenUrl: "/api/cli/device/token", verificationUri: "https://extension.dev/device" });
      }

      if (href.endsWith("/api/cli/device/token")) {
        polls += 1;

        if (polls <= pendingPolls) return reply(400, { error: "authorization_pending" });

        return reply(200, { token: GRANT, expiresAt: FUTURE, workspaceSlug: "acme", projectSlug: "widget", tokenKind: "provisioning" });
      }

      if (href.endsWith("/api/cli/projects/create")) {
        const headers = (init?.headers || {}) as Record<string, string>;
        creates.push(String(headers.authorization || ""));
        const answer = answers.shift() ?? "hang";

        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          if (answer !== "hang") setTimeout(() => resolve(reply(answer.status, answer.body)), answer.afterMs);
        });
      }

      throw new Error(`Unexpected fetch: ${href}`);
    }),
  );

  return { creates };
}

const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];
const saved: Record<string, string | undefined> = {};
let tmp: string;

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-create-long-call-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();

  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

async function blockingCreate(seconds: number) {
  const run = createProject({ project: PROJECT, repo: "octo/widget", deviceCode: "dev-code", waitSeconds: 900 } as never);
  await vi.advanceTimersByTimeAsync(seconds * 1000);

  return JSON.parse(await run);
}

describe("a create approved late in a blocking call keeps the login it mints (ledger 366)", () => {
  it("gives the create time to answer after minutes of waiting, and stores the minted token", async () => {
    const issued = { ...CREATED, tokenIssued: true, token: "project-token", expiresAt: FUTURE };
    const h = platform(24, [{ afterMs: 20_000, status: 200, body: issued }]);
    const out = await blockingCreate(160);

    expect(out.status).toBe("created");
    expect(out.value.login).toMatchObject({ stored: true, project: PROJECT });
    expect(readCredentials({ project: PROJECT, api: API })?.token).toBe("project-token");
    expect(h.creates).toEqual([`Bearer ${GRANT}`]);
  });

  it("reads the create back by the same grant once when it still gets no answer, instead of answering unconfirmed", async () => {
    const h = platform(24, ["hang", { afterMs: 1_000, status: 200, body: { ...CREATED, replayed: true } }]);
    const out = await blockingCreate(260);

    expect(out.status).toBe("created");
    expect(out.value).toMatchObject({ workspaceSlug: "acme", projectSlug: "widget", projectId: "prj_made" });
    expect(out.value.login).toEqual({ stored: false, project: PROJECT, reason: "replayed" });
    expect(h.creates).toEqual([`Bearer ${GRANT}`, `Bearer ${GRANT}`]);
    expect(JSON.stringify(out)).not.toContain(GRANT);
  });

  it("answers create-unconfirmed with the deviceCode kept when the read-back gets no answer either", async () => {
    const h = platform(24, ["hang", "hang"]);
    const out = await blockingCreate(260);

    expect(out.status).toBe("create-unconfirmed");
    expect(out.value.deviceCode).toBe("dev-code");
    expect(out.error.message).toContain("90 s");
    expect(h.creates).toHaveLength(2);
  });

  it("keeps a call that does not block inside the 45 s answer window, with no read-back", async () => {
    const h = platform(0, ["hang", { afterMs: 1_000, status: 200, body: { ...CREATED, replayed: true } }]);
    const run = createProject({ project: PROJECT, repo: "octo/widget", deviceCode: "dev-code" } as never);
    await vi.advanceTimersByTimeAsync(45_000);
    const out = JSON.parse(await run);

    expect(out.status).toBe("create-unconfirmed");
    expect(h.creates).toHaveLength(1);
  });
});
