import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FREE_ALLOWANCE_PHRASE } from "../lib/allowance";
import { handler as previewWeb } from "../tools/preview-web";
import { handler as publish } from "../tools/publish";
import { handler as promote } from "../tools/release-promote";
import { handler as submit } from "../tools/submit";
import { handler as projectCreate } from "../tools/project-create";

vi.mock("../lib/cdp-port", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/cdp-port")>()),
  resolveCdpPort: async () => null,
  resolveRdpPort: async () => null,
}));

const API = "https://api.test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function expectNarrated(allowance: any, what: string) {
  expect(allowance).toBeTruthy();
  expect(allowance.spent).toBe(
    `${what} ran on extension.dev's machines and ${FREE_ALLOWANCE_PHRASE}.`,
  );
  expect(allowance.remains).toBeTruthy();
  expect(allowance.wall).toContain("/pricing");
}

describe("every spending lane counts the allowance out loud in its result", () => {
  const origFetch = global.fetch;
  let tmp: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    "XDG_CONFIG_HOME",
    "EXTENSION_DEV_TOKEN",
    "EXTENSION_DEV_API_URL",
    "EXTENSION_DEV_APPROVAL_GATE",
    "EXTENSION_DEV_PREVIEW_URL",
  ];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-spend-"));
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_TOKEN = "tok_test";
    process.env.EXTENSION_DEV_API_URL = API;
    delete process.env.EXTENSION_DEV_APPROVAL_GATE;
    delete process.env.EXTENSION_DEV_PREVIEW_URL;
  });

  afterEach(() => {
    global.fetch = origFetch;
    vi.restoreAllMocks();
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("narrates the share upload spend on extension_preview_web share:true", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-dist-"));
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "Spend Ext", version: "1.0.0" }),
    );
    process.env.EXTENSION_DEV_API_URL = "https://www.extension.dev";
    global.fetch = (async (input: any, init: any) => {
      const url = String(input);
      if (init?.method === "POST") {
        return jsonResponse(
          {
            artifactId: "gen_spend",
            previewUrl: "https://preview.extension.dev/?preview=gen_spend",
            zipUrl:
              "https://www.extension.dev/api/artifacts/gen_spend/source.zip",
            revokeUrl: "https://www.extension.dev/api/artifacts/gen_spend",
            expiresAt: "2027-01-01T00:00:00.000Z",
            allowance: { used: 1, limit: 100 },
          },
          201,
        );
      }
      if (url.includes("/__preview/fetch")) {
        return new Response("not here", { status: 404 });
      }
      if (url.endsWith("/source.zip")) {
        return new Response(null, {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "access-control-allow-origin": "*",
          },
        });
      }
      throw new Error(`unrouted ${url}`);
    }) as unknown as typeof fetch;
    try {
      const out = JSON.parse(
        await previewWeb({
          projectPath: dir,
          build: false,
          distPath: dir,
          share: true,
        }),
      );
      expect(out.value.share.ok).toBe(true);
      expectNarrated(out.value.share.allowance, "This share upload");
      expect(out.value.share.allowance.remains).toBe(
        "The platform reports 1 of 100 used.",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("narrates the publish spend without inventing a count", async () => {
    global.fetch = (async () =>
      jsonResponse({
        shareUrl: "https://userland.extension.dev/acme/app",
        visibility: "public",
      })) as unknown as typeof fetch;
    const out = JSON.parse(await publish({}));
    expect(out.ok).toBe(true);
    expectNarrated(out.value.allowance, "This publish");
    expect(out.value.allowance.remains).not.toMatch(/\d/);
  });

  it("narrates the promote spend and relays the platform's numbers", async () => {
    global.fetch = (async () =>
      jsonResponse({
        message: "promoted",
        channel: "stable",
        allowance: { used: 9, limit: 100 },
      })) as unknown as typeof fetch;
    const out = JSON.parse(
      await promote({ buildId: "a1b2c3d", channel: "stable" }),
    );
    expect(out.ok).toBe(true);
    expectNarrated(out.value.allowance, "This promote");
    expect(out.value.allowance.remains).toBe(
      "The platform reports 9 of 100 used.",
    );
  });

  it("narrates a real submission and stays silent on a dry run", async () => {
    global.fetch = (async () =>
      jsonResponse({ ok: true, message: "dispatched", buildId: "a1b2c3d" })) as unknown as typeof fetch;
    const real = JSON.parse(
      await submit({ browsers: ["chrome"], buildSha: "a1b2c3d", dryRun: false }),
    );
    expect(real.status).toBe("submitted");
    expectNarrated(real.value.allowance, "This submission");

    global.fetch = (async () =>
      jsonResponse({ ok: true, message: "preflight ok", buildId: "a1b2c3d" })) as unknown as typeof fetch;
    const dry = JSON.parse(
      await submit({ browsers: ["chrome"], buildSha: "a1b2c3d" }),
    );
    expect(dry.status).toBe("preflight");
    expect(dry.value.allowance).toBeUndefined();
  });

  it("narrates the project creation spend, first build included", async () => {
    const FUTURE = Math.floor(Date.now() / 1000) + 900;
    global.fetch = (async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/cli/login/config")) {
        return jsonResponse({
          deviceCodeUrl: "/api/cli/device/code",
          deviceTokenUrl: "/api/cli/device/token",
          verificationUri: "https://extension.dev/device",
        });
      }
      if (url.endsWith("/api/cli/device/token")) {
        return jsonResponse({
          token: "provision-token",
          expiresAt: FUTURE,
          ttlSeconds: 900,
          workspaceSlug: "acme",
          projectSlug: "ghost-app",
          tokenKind: "provisioning",
        });
      }
      if (url.endsWith("/api/cli/projects/create")) {
        return jsonResponse({
          workspaceSlug: "acme",
          projectSlug: "ghost-app",
          projectId: "prj_1",
        });
      }
      throw new Error(`unrouted ${url}`);
    }) as unknown as typeof fetch;
    const out = JSON.parse(
      await projectCreate({
        project: "acme/ghost-app",
        repo: "acme/ghost-app-src",
        deviceCode: "dev-code",
      }),
    );
    expect(out.ok).toBe(true);
    expectNarrated(
      out.value.allowance,
      "This project creation, including its first build,",
    );
  });
});
