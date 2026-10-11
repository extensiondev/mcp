import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as projectCreate from "../tools/project-create";
import * as workspaceCreate from "../tools/workspace-create";

const API = "https://api.test";
const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];
const saved: Record<string, string | undefined> = {};
let tmp: string;

function stubPlatform(grant: Record<string, unknown>, createPath: string): string[] {
  const sent: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      sent.push(href);

      if (href.endsWith("/api/cli/login/config")) {
        return new Response(JSON.stringify({ verificationUri: "https://extension.dev/device" }));
      }

      if (href.endsWith("/api/cli/device/token")) {
        return new Response(JSON.stringify({ token: "provisioning-grant", expiresAt: 4_000_000_000, ...grant }));
      }

      if (href.endsWith(createPath)) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }

      throw new Error(`Unexpected fetch: ${href}`);
    }),
  );

  return sent;
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-single-create-"));
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

describe("a create with no answer is abandoned before the client's 60 s request timeout", () => {
  it("extension_project_create answers create-unconfirmed 45 s into the call", async () => {
    const sent = stubPlatform(
      { workspaceSlug: "acme", projectSlug: "widget", tokenKind: "provisioning" },
      "/api/cli/projects/create",
    );
    const pending = projectCreate.handler({ project: "acme/widget", repo: "octo/widget", deviceCode: "dev-code" });
    await vi.advanceTimersByTimeAsync(45_000);
    const out = JSON.parse(await pending);

    expect(out.status).toBe("create-unconfirmed");
    expect(out.error.message).toContain("60 s request timeout");
    expect(sent.filter((href) => href.endsWith("/api/cli/projects/create"))).toHaveLength(1);
  });

  it("extension_workspace_create answers create-unconfirmed 45 s into the call", async () => {
    const sent = stubPlatform(
      { workspaceSlug: "acme", tokenKind: "workspace-provisioning" },
      "/api/cli/workspaces/create",
    );
    const pending = workspaceCreate.handler({ workspace: "acme", deviceCode: "dev-code" });
    await vi.advanceTimersByTimeAsync(45_000);
    const out = JSON.parse(await pending);

    expect(out.status).toBe("create-unconfirmed");
    expect(out.error.message).toContain("60 s request timeout");
    expect(sent.filter((href) => href.endsWith("/api/cli/workspaces/create"))).toHaveLength(1);
  });
});
