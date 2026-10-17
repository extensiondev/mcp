import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { handler } from "../tools/publish";
import { publishAnswer } from "./fixtures/platform-answers";

describe("extension_publish envelope compatibility", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevToken: string | undefined;
  let prevApi: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-envelope-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevToken = process.env.EXTENSION_DEV_TOKEN;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.EXTENSION_DEV_TOKEN;
    delete process.env.EXTENSION_DEV_API_URL;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = prevToken;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the frozen PublishAuthError bytes when no token is available", async () => {
    const out = await handler({});
    expect(out).toBe(
      JSON.stringify({
        schema: 1,
        ok: false,
        command: "extension_publish",
        status: "auth-required",
        value: null,
        error: {
          code: "E_AUTH_REQUIRED",
          name: "PublishAuthError",
          message:
            "No token. Run extension_auth (action: login), or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard). An extension with no extension.dev project yet starts with extension_project_create, which makes one from its GitHub repository, then extension_auth.",
        },
        warnings: [],
      }),
    );
  });

  it("returns the frozen PublishConfigError bytes for a plaintext api URL", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok_test";
    const out = await handler({
      api: "http://evil.example.com",
    });
    expect(out).toBe(
      JSON.stringify({
        schema: 1,
        ok: false,
        command: "extension_publish",
        status: "publish-failed",
        value: null,
        error: {
          code: "E_PLATFORM",
          name: "PublishConfigError",
          message:
            "Refusing to send the access token to http://evil.example.com: use https (http is allowed only for localhost).",
        },
        warnings: [],
      }),
    );
  });

  it("names the remedy when the platform answers 404 for the token's project", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok_test";
    const origFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ message: "Project not found", code: "PROJECT_NOT_FOUND", createProjectUrl: "https://www.extension.dev/new" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      const out = JSON.parse(await handler({}));
      expect(out.ok).toBe(false);
      expect(out.status).toBe("publish-failed");
      expect(out.error.message).toContain("(404)");
      expect(out.hint).toMatch(/extension\.dev\/new/);
      expect(out.hint).toMatch(/extension_auth \(action: status\)/);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("sends EXTENSION_DEV_TOKEN for an unnamed call and the stored login for a named one", async () => {
    writeCredentials({
      version: 1,
      token: "tok_stored",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
    });

    const envToken = `${Buffer.from(JSON.stringify({ u: "acme", p: "widget", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
    process.env.EXTENSION_DEV_TOKEN = envToken;
    const bearers: string[] = [];
    const prevFetch = global.fetch;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      bearers.push(String((init?.headers as Record<string, string>)?.authorization ?? ""));

      return new Response(JSON.stringify({ message: "stop here", code: "PROJECT_NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      await handler({ api: "https://www.extension.dev" });
      await handler({ api: "https://www.extension.dev", project: "acme/widget" });
    } finally {
      global.fetch = prevFetch;
    }

    expect(bearers[0]).toBe(`Bearer ${envToken}`);
    expect(bearers[1]).toBe("Bearer tok_stored");
  });

  describe("share-link lifetime", () => {
    async function publishWith(ttlHours: number, expiresAt: string) {
      process.env.EXTENSION_DEV_TOKEN = "tok_test";
      const bodies: Array<Record<string, unknown>> = [];
      const prevFetch = global.fetch;
      global.fetch = (async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/api/cli/publish")) {
          bodies.push(JSON.parse(String(init?.body ?? "{}")));

          return new Response(JSON.stringify(publishAnswer({ expiresAt })), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;

      try {
        return { out: JSON.parse(await handler({ api: "https://www.extension.dev", ttlHours })), bodies };
      } finally {
        global.fetch = prevFetch;
      }
    }

    it.each([
      ["720 hours, a free plan's 30-day window", 720, "2026-11-04T12:00:00.000Z"],
      ["8760 hours, a Pro plan's 365-day window", 8760, "2027-10-05T12:00:00.000Z"],
      ["8760 hours on a free plan, which the platform cuts to 30 days", 8760, "2026-11-04T12:00:00.000Z"],
    ])("sends %s and reports the expiry the platform answers", async (_name, ttlHours, expiresAt) => {
      const { out, bodies } = await publishWith(ttlHours, expiresAt);

      expect(out.ok).toBe(true);
      expect(bodies).toEqual([{ ttlHours }]);
      expect(JSON.stringify(out)).toContain(expiresAt);
    });

    it("refuses a lifetime past a year before sending anything", async () => {
      const { out, bodies } = await publishWith(8761, "2027-10-05T12:00:00.000Z");

      expect(out.error.code).toBe("E_BAD_REQUEST");
      expect(out.error.message).toContain("8760");
      expect(bodies).toHaveLength(0);
    });
  });
});
