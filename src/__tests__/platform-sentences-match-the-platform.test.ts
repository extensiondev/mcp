
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { schema as submitSchema, handler as submit } from "../tools/submit";
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

describe("submit says what the platform checks and answers", () => {
  let tmp = "";
  const saved: Record<string, string | undefined> = {};
  let prevFetch: typeof fetch;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-submit-sentences-"));
    for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_APPROVAL_GATE"]) saved[key] = process.env[key];
    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
    prevFetch = global.fetch;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("names the owner gate, the draft upload and what a dry run skips in its description", () => {
    expect(submitSchema.description).toMatch(/does not run the owner gate, the approval, the build quota/);
    expect(submitSchema.description).toMatch(/absent_mode: safe/);
    expect(submitSchema.description).toMatch(/workspace owner/);
    expect(submitSchema.description).not.toMatch(/which does not check store health/);
  });

  it("renders the platform's warning objects and keeps a failing store configured but unhealthy", async () => {
    global.fetch = (async (url: string) => {
      const u = String(url);

      if (u.includes("/api/cli/stores/submit")) {
        return jsonResponse({
          ok: true,
          dryRun: true,
          buildId: "abc1234",
          warnings: [{ code: "FIREFOX_DATA_COLLECTION_PERMISSIONS", store: "firefox", message: "AMO requires data_collection_permissions.", docsUrl: "https://example.test/docs" }],
        });
      }

      if (u.includes("stores/health.json")) {
        return jsonResponse({ stores: { firefox: { ok: false, message: "AMO credentials expired" } } });
      }

      if (u.includes("channels.json")) return jsonResponse({ stable: { sha: "abc1234" } });

      return jsonResponse({});
    }) as unknown as typeof fetch;

    const out = JSON.parse(await submit({ browsers: ["firefox"], buildSha: "abc1234" }));
    expect(out.warnings.join("\n")).toMatch(/firefox: AMO requires data_collection_permissions\. \(https:\/\/example\.test\/docs\)/);
    expect(out.value.preflight[0]).toMatchObject({ configured: true, healthy: false, ok: false });
    expect(out.value.preflight[0].reason).toMatch(/AMO credentials expired/);
  });

  it("lists what the dry run did not check beside what it did", async () => {
    global.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/api/cli/stores/submit")) return jsonResponse({ ok: true, dryRun: true, buildId: "abc1234" });
      if (u.includes("stores/health.json")) return jsonResponse({ stores: { chrome: { ok: true } } });
      if (u.includes("channels.json")) return jsonResponse({ stable: { sha: "abc1234" } });

      return jsonResponse({});
    }) as unknown as typeof fetch;

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "abc1234" }));
    expect(out.hint).toMatch(/Not checked by a dry run: the owner gate, the approval, the build quota, the dispatch pause and the submission mode/);
    expect(out.hint).not.toMatch(/verified auth, the project, build/);
  });

  it("says when the submission record appears and that a draft upload is not review", async () => {
    global.fetch = (async (url: string) => {
      const u = String(url);

      if (u.includes("/api/cli/stores/submit")) {
        return jsonResponse({ ok: true, projectId: "p", buildId: "abc1234", channel: "stable", submissions: [{ store: "chrome", status: "pending" }], origin: "cli" });
      }

      return jsonResponse({});
    }) as unknown as typeof fetch;

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "abc1234", dryRun: false }));
    expect(out.status).toBe("submitted");
    expect(out.hint).toMatch(/uploaded as a draft \(absent_mode: safe\) and does not enter review/);
    expect(out.warnings.join("\n")).toMatch(/appears in the registry's stores\/submissions\.json when the store workflow reports/);
    expect(out.warnings.join("\n")).not.toMatch(/reads the recorded outcome, per-store credential health, and review state/);
  });

  it("says a presented approval was spent when the platform refused after consuming it", async () => {
    global.fetch = (async (url: string) => {
      const u = String(url);

      if (u.includes("/api/cli/stores/submit")) {
        return jsonResponse({ ok: false, message: "Build quota exhausted for this month.", code: "BUILD_QUOTA_EXHAUSTED" }, false, 429);
      }

      return jsonResponse({});
    }) as unknown as typeof fetch;

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "abc1234", dryRun: false, approvalId: "appr-1" }));
    expect(out.status).toBe("submit-failed");
    expect(out.hint).toMatch(/approval presented with this call was spent/);
    expect(out.hint).toMatch(/call again with no approvalId/);
  });

  it("does not call an approval spent when the refusal came before the platform consumed it", async () => {
    global.fetch = (async (url: string) => {
      const u = String(url);

      if (u.includes("/api/cli/stores/submit")) {
        return jsonResponse({ ok: false, message: "Only the workspace owner may submit.", code: "OWNER_REQUIRED" }, false, 403);
      }

      return jsonResponse({});
    }) as unknown as typeof fetch;

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "abc1234", dryRun: false, approvalId: "appr-1" }));
    expect(out.hint ?? "").not.toMatch(/was spent/);
  });
});

describe("publish, promote, builds, the share probe and the grant refusal", () => {
  it("publish and promote describe the platform's actual sha and browser handling", () => {
    const buildSha = (publishSchema.inputSchema.properties as Record<string, { description: string }>).buildSha.description;
    expect(buildSha).toMatch(/echoes the sha back/);
    expect(buildSha).not.toMatch(/always points at a real build/);
    const browsers = (promoteSchema.inputSchema.properties as Record<string, { description: string }>).browsers.description;
    expect(browsers).toMatch(/falls back to chrome alone/);
    expect(browsers).not.toMatch(/auto-detected from the build\)/);
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
        return (this as unknown as { mint: (r: typeof ref) => Promise<unknown> }).mint(ref);
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
