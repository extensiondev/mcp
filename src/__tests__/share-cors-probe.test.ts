import { describe, expect, it } from "vitest";

import { probeShareCors } from "../lib/share-cors-probe";

const ORIGIN = "https://preview.extension.dev";
const ZIP = "https://www.extension.dev/api/artifacts/gen_abc/source.zip";
const SIGNED = "https://acct.r2.cloudflarestorage.com/bucket/gen_abc.zip?sig=1";

function respond(
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(null, { status, headers });
}

function router(
  routes: Record<string, () => Response>,
): { impl: typeof fetch; seen: { url: string; origin: string | null }[] } {
  const seen: { url: string; origin: string | null }[] = [];
  const impl = (async (input: any, init: any) => {
    const url = String(input);
    seen.push({
      url,
      origin: new Headers(init?.headers ?? {}).get("origin"),
    });
    const route = routes[url];
    if (!route) throw new Error(`unrouted ${url}`);
    return route();
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("probeShareCors", () => {
  it("fails a redirect whose CORS headers die on the hop", async () => {
    const { impl, seen } = router({
      [ZIP]: () =>
        respond(302, {
          location: SIGNED,
          "access-control-allow-origin": "*",
        }),
      [SIGNED]: () => respond(200, { "content-type": "application/zip" }),
    });

    const verdict = await probeShareCors({
      zipUrl: ZIP,
      origin: ORIGIN,
      fetchImpl: impl,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.redirects).toBe(1);
    expect(verdict.finalUrl).toBe(SIGNED);
    expect(verdict.finalStatus).toBe(200);
    expect(verdict.allowOrigin).toBeNull();
    expect(verdict.reason).toContain("no access-control-allow-origin");
    expect(verdict.reason).toContain("not on the redirect");
    expect(seen.every((call) => call.origin === ORIGIN)).toBe(true);
  });

  it("passes when the response the browser reads carries the header", async () => {
    const { impl } = router({
      [ZIP]: () =>
        respond(200, {
          "content-type": "application/zip",
          "access-control-allow-origin": "*",
        }),
    });

    const verdict = await probeShareCors({
      zipUrl: ZIP,
      origin: ORIGIN,
      fetchImpl: impl,
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.redirects).toBe(0);
    expect(verdict.allowOrigin).toBe("*");
  });

  it("passes when the final hop names the preview origin exactly", async () => {
    const { impl } = router({
      [ZIP]: () => respond(302, { location: SIGNED }),
      [SIGNED]: () =>
        respond(200, { "access-control-allow-origin": ORIGIN }),
    });

    const verdict = await probeShareCors({
      zipUrl: ZIP,
      origin: ORIGIN,
      fetchImpl: impl,
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.redirects).toBe(1);
  });

  it("fails when the final hop allows some other origin", async () => {
    const { impl } = router({
      [ZIP]: () =>
        respond(200, {
          "access-control-allow-origin": "https://example.com",
        }),
    });

    const verdict = await probeShareCors({
      zipUrl: ZIP,
      origin: ORIGIN,
      fetchImpl: impl,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("does not cover");
  });

  it("reads a held response as held rather than as a broken link", async () => {
    const { impl } = router({
      [ZIP]: () =>
        respond(503, { "x-extensiondev-hold": "held" }),
    });

    const verdict = await probeShareCors({
      zipUrl: ZIP,
      origin: ORIGIN,
      fetchImpl: impl,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.held).toBe(true);
    expect(verdict.finalStatus).toBe(503);
    expect(verdict.reason).toContain("held");
    expect(verdict.reason).toContain("not broken");
    expect(verdict.reason).not.toContain("nothing to render");
  });

  it("does not call an ordinary 503 held when the hold signal is absent", async () => {
    const { impl } = router({
      [ZIP]: () => respond(503, { "access-control-allow-origin": "*" }),
    });

    const verdict = await probeShareCors({
      zipUrl: ZIP,
      origin: ORIGIN,
      fetchImpl: impl,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.held).toBe(false);
    expect(verdict.reason).toContain("nothing to render");
  });

  it("fails a dead artifact rather than reporting a CORS problem", async () => {
    const { impl } = router({
      [ZIP]: () => respond(404, { "access-control-allow-origin": "*" }),
    });

    const verdict = await probeShareCors({
      zipUrl: ZIP,
      origin: ORIGIN,
      fetchImpl: impl,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.finalStatus).toBe(404);
    expect(verdict.reason).toContain("404");
  });

  it("fails rather than throwing when the host cannot be reached", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const verdict = await probeShareCors({
      zipUrl: ZIP,
      origin: ORIGIN,
      fetchImpl: impl,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("ECONNREFUSED");
  });

  it("gives up on a redirect loop instead of following it forever", async () => {
    const impl = (async () => respond(302, { location: ZIP })) as unknown as typeof fetch;

    const verdict = await probeShareCors({
      zipUrl: ZIP,
      origin: ORIGIN,
      fetchImpl: impl,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("redirected more than");
  });
});
