import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchRegistryJson } from "../lib/registry";
import {
  RegistryAccessTokens,
  withAccessToken,
} from "../lib/registry-access";


vi.mock("../lib/credentials", () => ({
  readCredentials: vi.fn(() => ({
    version: 1 as const,
    token: "stored-long-lived-token",
    workspaceSlug: "acme",
    projectSlug: "widget",
    expiresAt: 0,
    api: "https://www.extension.dev",
  })),
}));

const REF = { workspace: "acme", project: "widget" };
const URL_UNDER_TEST =
  "https://registry.extension.land/acme/widget/_extension-dev/channels.json";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  delete process.env.EXTENSION_DEV_TOKEN;
});

describe("public projects", () => {
  it("reads in one request and never calls the platform", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: any) => {
      calls.push(String(url));
      return jsonResponse({ "chrome-stable": { sha: "abc1234" } });
    });

    const res = await fetchRegistryJson(URL_UNDER_TEST, fetchImpl as any, {
      ref: REF,
      tokens: new RegistryAccessTokens({ fetchImpl: fetchImpl as any }),
    });

    expect(res.ok).toBe(true);
    expect(calls).toEqual([URL_UNDER_TEST]);
    expect(calls.some((u) => u.includes("access-grant"))).toBe(false);
    expect(calls.some((u) => u.includes("?t="))).toBe(false);
  });

  it("passes a non-auth failure straight through without minting", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404));
    const res = await fetchRegistryJson(URL_UNDER_TEST, fetchImpl as any, {
      ref: REF,
      tokens: new RegistryAccessTokens({ fetchImpl: fetchImpl as any }),
    });
    expect(res.ok).toBe(false);
    expect((res as { status?: number }).status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("private projects", () => {
  it("mints a short-lived token on 401 and retries once with ?t=", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: any, init?: any) => {
      const href = String(url);
      calls.push(href);
      if (href.includes("/api/access-grant")) {
        expect(init?.headers?.authorization).toBe(
          "Bearer stored-long-lived-token",
        );
        return jsonResponse({
          token: "short-lived-token",
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        });
      }
      if (href.includes("t=short-lived-token")) {
        return jsonResponse({ "chrome-stable": { sha: "abc1234" } });
      }
      return jsonResponse({ message: "unauthorized" }, 401);
    });

    const res = await fetchRegistryJson(URL_UNDER_TEST, fetchImpl as any, {
      ref: REF,
      tokens: new RegistryAccessTokens({ fetchImpl: fetchImpl as any }),
    });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain("/api/access-grant");
    expect(calls[2]).toContain("t=short-lived-token");
  });

  it("never puts the long-lived stored token in a URL", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: any) => {
      const href = String(url);
      calls.push(href);
      if (href.includes("/api/access-grant")) {
        return jsonResponse({ token: "short-lived-token", expiresAt: 0 });
      }
      if (href.includes("t=")) return jsonResponse({});
      return jsonResponse({}, 401);
    });

    await fetchRegistryJson(URL_UNDER_TEST, fetchImpl as any, {
      ref: REF,
      tokens: new RegistryAccessTokens({ fetchImpl: fetchImpl as any }),
    });

    expect(calls.some((u) => u.includes("stored-long-lived-token"))).toBe(false);
  });

  it("shares one mint across a fan-out of concurrent reads", async () => {
    let mints = 0;
    const fetchImpl = vi.fn(async (url: any) => {
      const href = String(url);
      if (href.includes("/api/access-grant")) {
        mints += 1;
        return jsonResponse({
          token: "short-lived-token",
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        });
      }
      if (href.includes("t=short-lived-token")) return jsonResponse({ ok: 1 });
      return jsonResponse({}, 401);
    });

    const tokens = new RegistryAccessTokens({ fetchImpl: fetchImpl as any });
    const results = await Promise.all(
      ["channels.json", "meta.json", "builds/index.json"].map((file) =>
        fetchRegistryJson(
          `https://registry.extension.land/acme/widget/_extension-dev/${file}`,
          fetchImpl as any,
          { ref: REF, tokens },
        ),
      ),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(mints).toBe(1);
  });

  it("explains what to do when no credential covers the project", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const res = await fetchRegistryJson(
      "https://registry.extension.land/someone/else/_extension-dev/channels.json",
      fetchImpl as any,
      {
        ref: { workspace: "someone", project: "else" },
        tokens: new RegistryAccessTokens({ fetchImpl: fetchImpl as any }),
      },
    );
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toContain("extension_login");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("leaves the old behaviour untouched when no ref is given", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const res = await fetchRegistryJson(URL_UNDER_TEST, fetchImpl as any);
    expect(res.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("withAccessToken", () => {
  it("adds t= and leaves an unparseable url alone", () => {
    expect(withAccessToken("https://x.test/a", "tok")).toBe(
      "https://x.test/a?t=tok",
    );
    expect(withAccessToken("https://x.test/a", "")).toBe("https://x.test/a");
    expect(withAccessToken("not a url", "tok")).toBe("not a url");
  });
});
