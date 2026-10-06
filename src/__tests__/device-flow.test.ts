import { describe, expect, it } from "vitest";

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
});
