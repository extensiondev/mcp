import { describe, expect, it } from "vitest";

import { withRequestCredential } from "../lib/credential-scope";
import { pollDeviceGrant, requestDeviceCode } from "../lib/device-flow";

function answer(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

describe("requestDeviceCode reads the platform's numbers, never NaN", () => {
  it("falls back to the defaults for a garbled interval or expiry", async () => {
    const start = await requestDeviceCode({
      apiBase: "http://localhost:3100",
      path: "/api/cli/device/code",
      project: "acme/widget",
      fetchImpl: async () =>
        answer({ device_code: "d", user_code: "U", interval: "soon", expires_in: "later" }),
    });

    expect(start.interval).toBe(5);
    expect(start.expiresIn).toBe(900);
  });

  it("derives the verification page from the api base when the platform names none", async () => {
    const start = await requestDeviceCode({
      apiBase: "http://localhost:3100",
      path: "/api/cli/device/code",
      project: "acme/widget",
      fetchImpl: async () => answer({ device_code: "d", user_code: "U" }),
    });

    expect(start.verificationUri).toBe("http://localhost:3100/device");
    expect(start.verificationUri).not.toContain("extension.dev");
  });
});

describe("requestDeviceCode and a platform that refuses the lifetime field", () => {
  it("1078: starts again without it for a create only, and answers the lifetime the accepted start carried", async () => {
    const run = async (intent: "login" | "create" | "create-workspace", refuses: boolean) => {
      const bodies: Array<Record<string, unknown>> = [];
      const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);

        return refuses && body.lifetime ? answer({ code: "DEVICE_LIFETIME_INVALID", message: "refused" }, 400) : answer({ device_code: "d", user_code: "U" });
      }) as typeof fetch;
      const start = await requestDeviceCode({ apiBase: "http://localhost:3100", path: "/api/cli/device/code", project: "acme/widget", intent, lifetime: "hour", fetchImpl }).catch((error: Error & { serverCode?: string }) => error.serverCode);

      return { lifetimes: bodies.map((body) => body.lifetime), start: typeof start === "string" ? start : start?.lifetime };
    };

    expect(await run("create", false)).toEqual({ lifetimes: ["hour"], start: "hour" });
    expect(await run("create", true)).toEqual({ lifetimes: ["hour", undefined], start: undefined });
    expect(await run("login", true)).toEqual({ lifetimes: ["hour"], start: "DEVICE_LIFETIME_INVALID" });
    expect(await run("create-workspace", true)).toEqual({ lifetimes: [undefined], start: undefined });
  });
});

describe("pollDeviceGrant never calls an answer it cannot read pending", () => {
  it.each([["an empty object", {}], ["a page of html", "<html>ok</html>"], ["tokens with no token", { tokens: [{ token: "t" }] }]])(
    "answers error for %s",
    async (_label, body) => {
      const result = await pollDeviceGrant({
        apiBase: "https://api.test",
        path: "/api/cli/device/token",
        project: "acme/widget",
        deviceCode: "d",
        interval: 1,
        budgetMs: 2_000,
        fetchImpl: async () => answer(body),
      });

      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toBe("error");
      expect((result as { message?: string }).message).toContain("without a token");
    },
  );

  it("still reports a real pending answer as pending", async () => {
    const result = await pollDeviceGrant({
      apiBase: "https://api.test",
      path: "/api/cli/device/token",
      project: "acme/widget",
      deviceCode: "d",
      interval: 1,
      budgetMs: 500,
      fetchImpl: async () => answer({ error: "authorization_pending" }, 400),
    });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("pending");
  });

  it("relays the platform's Retry-After on a rate-limited poll and says the code is still pending", async () => {
    const result = await pollDeviceGrant({
      apiBase: "https://api.test",
      path: "/api/cli/device/token",
      project: "acme/widget",
      deviceCode: "d",
      interval: 1,
      budgetMs: 500,
      fetchImpl: (async () => new Response(JSON.stringify({ message: "Too many polls." }), { status: 429, headers: { "retry-after": "42", "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("error");
    expect((result as { message?: string }).message).toMatch(/42 seconds/);
    expect((result as { message?: string }).message).toMatch(/still pending/);
  });

  it("treats slow_down as a wider interval, not an end", async () => {
    const result = await pollDeviceGrant({
      apiBase: "https://api.test",
      path: "/api/cli/device/token",
      project: "acme/widget",
      deviceCode: "d",
      interval: 1,
      budgetMs: 500,
      fetchImpl: (async () => new Response(JSON.stringify({ error: "slow_down" }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("pending");
  });
});

describe("a device start made for a hosted caller names that caller", () => {
  const sent: Array<{ url: string; authorization: string | null; redirect: unknown }> = [];

  const platform = async (input: unknown, init?: RequestInit) => {
    sent.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });

    return String(input).endsWith("/token") ? answer({ token: "t" }) : answer({ device_code: "d", user_code: "U" });
  };

  const caller = (api: string) => ({ token: "caller-grant", api, projects: [{ workspace: "acme", project: "web" }], expiresAt: null });
  const start = (apiBase: string) => requestDeviceCode({ apiBase, path: "/api/cli/device/code", project: "acme/new", intent: "create", fetchImpl: platform as typeof fetch });

  it("carries the caller's own bearer on the start and the poll, to its own platform only and never through a redirect", async () => {
    sent.length = 0;
    await withRequestCredential(caller("https://www.extension.dev"), async () => {
      await start("https://www.extension.dev");
      await pollDeviceGrant({ apiBase: "https://www.extension.dev", path: "/api/cli/device/token", deviceCode: "d", interval: 1, budgetMs: 10, fetchImpl: platform as typeof fetch });
      await start("https://www.example.com");
    });

    expect(sent.map((call) => call.authorization)).toEqual(["Bearer caller-grant", "Bearer caller-grant", null]);
    expect(sent.slice(0, 2).map((call) => call.redirect)).toEqual(["manual", "manual"]);
  });

  it("sends no bearer from the local server, which has no request credential", async () => {
    sent.length = 0;
    await start("https://www.extension.dev");

    expect(sent).toEqual([{ url: "https://www.extension.dev/api/cli/device/code", authorization: null, redirect: undefined }]);
  });

  it("refuses a redirect on a start that carries the caller's bearer", async () => {
    const redirecting = (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } })) as typeof fetch;

    await expect(
      withRequestCredential(caller("https://www.extension.dev"), () =>
        requestDeviceCode({ apiBase: "https://www.extension.dev", path: "/api/cli/device/code", project: "acme/new", fetchImpl: redirecting }),
      ),
    ).rejects.toThrow(/never sent to a redirect/);
  });
});
