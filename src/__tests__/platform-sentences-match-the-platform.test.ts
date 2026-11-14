
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { schema as publishSchema } from "../tools/publish";
import { schema as promoteSchema } from "../tools/release-promote";
import { isPartialBuild, isSuccessfulBuild, parseBuildIndex } from "../lib/registry";
import { probeShareCors } from "../lib/share-cors-probe";
import { RegistryAccessTokens } from "../lib/registry-access";

function claimsToken(u: string, p: string): string {
  return `${Buffer.from(JSON.stringify({ u, p, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, headers: { get: () => null }, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe("publish, promote, builds, the share probe and the grant refusal", () => {
  it("publish and promote describe the platform's actual sha and browser handling", () => {
    const buildSha = (publishSchema.inputSchema.properties as Record<string, { description: string }>).buildSha.description;
    expect(buildSha).toMatch(/echoes the sha back/);
    const browsers = (promoteSchema.inputSchema.properties as Record<string, { description: string }>).browsers.description;
    expect(browsers).toMatch(/falls back to chrome alone/);
  });

  it("does not call a partial build successful", () => {
    const items = parseBuildIndex({ items: [{ sha: "abc1234", status: "success", summaryStatus: "partial" }, { sha: "def5678", status: "success" }] });
    expect(items[0].summaryStatus).toBe("partial");
    expect(isPartialBuild(items[0])).toBe(true);
    expect(isSuccessfulBuild(items[0])).toBe(false);
    expect(isSuccessfulBuild(items[1])).toBe(true);
  });

  it("reads the hold out of a 403 body with no hold header", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "not open", code: "PLATFORM_NOT_OPEN" }), { status: 403, headers: { "content-type": "application/json" } }));
    const verdict = await probeShareCors({ zipUrl: "https://registry.test/a/source.zip", origin: "https://preview.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(verdict.held).toBe(true);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/held/);
    expect(verdict.reason).not.toMatch(/nothing to render/);
  });

  it("keeps a plain 403 as a broken link", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "forbidden" }), { status: 403 }));
    const verdict = await probeShareCors({ zipUrl: "https://registry.test/a/chrome.zip", origin: "https://preview.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(verdict.held).toBe(false);
    expect(verdict.reason).toMatch(/nothing to render/);
  });

  it("carries the platform's refusal reason on a denied grant", async () => {
    class Probe extends RegistryAccessTokens {
      mintFor(ref: { workspace: string; project: string }) {
        return this.get(ref);
      }
    }
    const prev = process.env.EXTENSION_DEV_TOKEN;
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");

    try {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Token revoked.", reason: "token-revoked" }), { status: 401 }));
      const grant = (await new Probe({ fetchImpl: fetchImpl as unknown as typeof fetch }).mintFor({ workspace: "acme", project: "widget" })) as { status: string; message?: string; reason?: string };
      expect(grant.status).toBe("denied");
      expect(grant.reason).toBe("token-revoked");
      expect(grant.message).toMatch(/token-revoked: Token revoked\./);
    } finally {
      if (prev === undefined) delete process.env.EXTENSION_DEV_TOKEN;
      else process.env.EXTENSION_DEV_TOKEN = prev;
    }
  });
});
