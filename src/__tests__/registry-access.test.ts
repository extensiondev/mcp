import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withRequestCredential, type RequestCredential } from "../lib/credential-scope";
import { writeCredentials, type StoredCredentials } from "../lib/credentials";
import { fetchRegistryJson } from "../lib/registry";
import {
  RegistryAccessTokens,
  withAccessToken,
} from "../lib/registry-access";

const STORED: StoredCredentials = {
  version: 1,
  token: "stored-long-lived-token",
  workspaceSlug: "acme",
  projectSlug: "widget",
  expiresAt: 0,
  api: "https://www.extension.dev",
};

function setStored(creds: StoredCredentials | null): void {
  fs.rmSync(path.join(configDir, "extension-dev"), { recursive: true, force: true });
  if (creds) writeCredentials(creds);
}

let configDir = "";
const prevXdg = process.env.XDG_CONFIG_HOME;
const prevAppData = process.env.APPDATA;

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  if (prevAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = prevAppData;
});

const REF = { workspace: "acme", project: "widget" };
const URL_UNDER_TEST =
  "https://registry.extension.land/acme/widget/_extension-dev/channels.json";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  delete process.env.EXTENSION_DEV_TOKEN;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-registry-access-"));
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.APPDATA = configDir;
  setStored(STORED);
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

function claimsToken(u: string, p: string): string {
  return `${Buffer.from(JSON.stringify({ u, p, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
}

class Probe extends RegistryAccessTokens {
  mintFor(ref: { workspace: string; project: string }) {
    return this.get(ref);
  }
}

describe("the grant is asked with the named project's stored login first", () => {
  it("sends the stored login, not EXTENSION_DEV_TOKEN, when both exist", async () => {
    process.env.EXTENSION_DEV_TOKEN = claimsToken("other", "thing");

    try {
      const bearers: string[] = [];
      const fetchImpl = vi.fn(async (_url: any, init?: any) => {
        bearers.push(String(init?.headers?.authorization ?? ""));

        return jsonResponse({ token: "short", expiresAt: Math.floor(Date.now() / 1000) + 600 });
      });
      const grant = await new Probe({ fetchImpl: fetchImpl as any }).mintFor(REF);
      expect(grant).toMatchObject({ status: "ok", token: "short" });
      expect(bearers).toEqual(["Bearer stored-long-lived-token"]);
    } finally {
      delete process.env.EXTENSION_DEV_TOKEN;
    }
  });

  it("does not send an env token whose claims name another project", async () => {
    process.env.EXTENSION_DEV_TOKEN = claimsToken("other", "thing");
    setStored(null);

    try {
      const fetchImpl = vi.fn(async () => jsonResponse({ token: "short", expiresAt: 1 }));
      const grant = await new Probe({ fetchImpl: fetchImpl as any }).mintFor(REF);
      expect(grant).toEqual({ status: "no-credential" });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      delete process.env.EXTENSION_DEV_TOKEN;
    }
  });

  it("sends an env token whose claims name this project when nothing is stored", async () => {
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
    setStored(null);

    try {
      const bearers: string[] = [];
      const fetchImpl = vi.fn(async (_url: any, init?: any) => {
        bearers.push(String(init?.headers?.authorization ?? ""));

        return jsonResponse({ token: "short", expiresAt: Math.floor(Date.now() / 1000) + 600 });
      });
      const grant = await new Probe({ fetchImpl: fetchImpl as any }).mintFor(REF);
      expect(grant).toMatchObject({ status: "ok" });
      expect(bearers[0]).toBe(`Bearer ${process.env.EXTENSION_DEV_TOKEN}`);
    } finally {
      delete process.env.EXTENSION_DEV_TOKEN;
    }
  });

  it("reads public off the 400 body's visibility and nothing else", async () => {
    const publicFetch = vi.fn(async () => jsonResponse({ message: "Project is public; no access token is required.", visibility: "public" }, 400));
    expect(await new Probe({ fetchImpl: publicFetch as any }).mintFor(REF)).toEqual({ status: "public" });
    const bareFetch = vi.fn(async () => jsonResponse({ message: "workspaceSlug and projectSlug are required." }, 400));
    expect(await new Probe({ fetchImpl: bareFetch as any }).mintFor(REF)).toMatchObject({ status: "denied", httpStatus: 400 });
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

  it("a member login minted through workspace acme reads private acme/other with the project header, and the acme/widget project token is not sent for it", async () => {
    writeCredentials({
      version: 1,
      token: "member-login-token",
      workspaceSlug: "acme",
      projectSlug: "*",
      kind: "member",
      projectSlugs: ["widget", "other"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
    });

    const grants: Array<{ authorization: string; project: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: any, init?: any) => {
      const href = String(url);

      if (href.includes("/api/access-grant")) {
        grants.push({
          authorization: String(init?.headers?.authorization ?? ""),
          project: String(init?.headers?.["x-extensiondev-project"] ?? ""),
          body: JSON.parse(String(init?.body)),
        });

        return jsonResponse({ token: "short-lived-token", expiresAt: Math.floor(Date.now() / 1000) + 600 });
      }

      if (href.includes("t=short-lived-token")) return jsonResponse({ "chrome-stable": { sha: "abc1234" } });

      return jsonResponse({ error: "unauthorized", reason: "missing-token" }, 401);
    });

    const res = await fetchRegistryJson("https://registry.extension.land/acme/other/_extension-dev/channels.json", fetchImpl as any, {
      ref: { workspace: "acme", project: "other" },
      tokens: new RegistryAccessTokens({ fetchImpl: fetchImpl as any }),
    });

    expect(res.ok).toBe(true);
    expect(grants).toEqual([
      { authorization: "Bearer member-login-token", project: "acme/other", body: { workspaceSlug: "acme", projectSlug: "other" } },
    ]);

    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("stored-long-lived-token");
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

  it.each([
    { label: "a caller whose token covers another project", second: { token: "stranger-token", projects: [{ workspace: "evil", project: "x" }] }, grants: 1 },
    { label: "a second caller covering the same project", second: { token: "colleague-token", projects: [REF] }, grants: 2 },
  ])("a cached registry token is served only to the credential that minted it, never to $label", async ({ second, grants }) => {
    const owner: RequestCredential = { token: "owner-token", api: "https://www.extension.dev", projects: [REF], expiresAt: null };
    const other: RequestCredential = { ...owner, ...second };
    const asked: string[] = [];
    const reads: string[] = [];
    const fetchImpl = vi.fn(async (url: any, init?: any) => {
      const href = String(url);

      if (href.includes("/api/access-grant")) {
        const bearer = String(init?.headers?.authorization ?? "").replace("Bearer ", "");
        asked.push(bearer);

        return jsonResponse({ token: `short-for-${bearer}`, expiresAt: Math.floor(Date.now() / 1000) + 600 });
      }

      reads.push(href);

      return href.includes("t=short-for-") ? jsonResponse({ "chrome-stable": { sha: "abc1234" } }) : jsonResponse({}, 401);
    });
    const tokens = new RegistryAccessTokens({ fetchImpl: fetchImpl as any });
    const read = () => fetchRegistryJson(URL_UNDER_TEST, fetchImpl as any, { ref: REF, tokens });

    expect((await withRequestCredential(owner, read)).ok).toBe(true);
    reads.length = 0;

    const res = await withRequestCredential(other, read);

    expect(reads.some((href) => href.includes("short-for-owner-token"))).toBe(false);
    expect(asked).toHaveLength(grants);
    expect(res.ok).toBe(grants === 2);
    if (grants === 2) expect(reads[reads.length - 1]).toContain(`t=short-for-${second.token}`);
  });

  it("never posts an expired stored token; it asks for a fresh login instead", async () => {
    setStored({
      ...STORED,
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });

    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const res = await fetchRegistryJson(URL_UNDER_TEST, fetchImpl as any, {
      ref: REF,
      tokens: new RegistryAccessTokens({ fetchImpl: fetchImpl as any }),
    });
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toContain("extension_auth");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      ref: { workspace: "acme", project: "other" },
      detail:
        'No stored login covers acme/other: a login is minted per project, and the login stored for acme (acme/widget) does not read it, so run extension_auth {action: "login", project: "acme/other"}, or extension_auth {action: "login", workspace: "acme", projects: "*"} to cover every project of the workspace in one approval.',
    },
    {
      ref: { workspace: "someone", project: "else" },
      detail:
        'No stored login covers someone/else: a login is minted per project, so run extension_auth {action: "login", project: "someone/else"}, or extension_auth {action: "login", workspace: "someone", projects: "*"} to cover every project of the workspace in one approval.',
    },
  ])("a read of $ref.workspace/$ref.project with no login for it names the exact login call in one sentence", async ({ ref, detail }) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "unauthorized", reason: "missing-token" }, 401));
    const url = `https://registry.extension.land/${ref.workspace}/${ref.project}/_extension-dev/channels.json`;
    const res = await fetchRegistryJson(url, fetchImpl as any, {
      ref,
      tokens: new RegistryAccessTokens({ fetchImpl: fetchImpl as any }),
    });
    expect(res.ok).toBe(false);
    const message = (res as { message: string }).message;
    expect(message.startsWith(`${url} returned 401`)).toBe(true);
    expect(message.endsWith(` ${detail}`)).toBe(true);
    expect((res as { loginNeeded?: string }).loginNeeded).toBe(detail);
    expect((res as { message: string }).message).not.toContain("set EXTENSION_DEV_TOKEN");
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
