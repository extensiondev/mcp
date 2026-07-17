import { describe, expect, it } from "vitest";
import { pollForToken, startDeviceCode } from "../lib/github-device";

const noSleep = async () => {};

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe("startDeviceCode", () => {
  it("parses a successful device-code response", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        device_code: "dc",
        user_code: "WXYZ-1234",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 900,
      })) as unknown as typeof fetch;

    const start = await startDeviceCode({ clientId: "cid", fetchImpl });
    expect(start.deviceCode).toBe("dc");
    expect(start.userCode).toBe("WXYZ-1234");
    expect(start.interval).toBe(5);
    expect(start.expiresIn).toBe(900);
  });

  it("throws on an error response", async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { error: "unauthorized_client" },
        false,
      )) as unknown as typeof fetch;
    await expect(
      startDeviceCode({ clientId: "cid", fetchImpl }),
    ).rejects.toThrow(/device-code request failed/);
  });
});

describe("pollForToken", () => {
  it("returns the token after a pending poll", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: "authorization_pending" })
        : jsonResponse({ access_token: "ghtoken" });
    }) as unknown as typeof fetch;

    const result = await pollForToken({
      clientId: "cid",
      deviceCode: "dc",
      interval: 1,
      budgetMs: 10_000,
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(result).toEqual({ ok: true, githubToken: "ghtoken" });
    expect(calls).toBe(2);
  });

  it("reports denied terminally", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: "access_denied" })) as unknown as typeof fetch;
    const result = await pollForToken({
      clientId: "cid",
      deviceCode: "dc",
      interval: 1,
      budgetMs: 10_000,
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(result).toEqual({ ok: false, reason: "denied" });
  });

  it("reports expired terminally", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: "expired_token" })) as unknown as typeof fetch;
    const result = await pollForToken({
      clientId: "cid",
      deviceCode: "dc",
      interval: 1,
      budgetMs: 10_000,
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("reports pending when the budget is exhausted without polling", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ error: "authorization_pending" });
    }) as unknown as typeof fetch;

    const result = await pollForToken({
      clientId: "cid",
      deviceCode: "dc",
      interval: 1,
      budgetMs: 0,
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(result).toEqual({ ok: false, reason: "pending" });
    expect(calls).toBe(0);
  });
});
