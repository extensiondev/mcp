import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler, schema } from "../tools/docs-search";

const calls: string[] = [];

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("EXTENSION_DEV_API_URL", "https://www.extension.dev");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("extension_docs_search", () => {
  it("keeps its description short so it costs little context", () => {
    expect(schema.description.split(/\s+/).length).toBeLessThan(60);
  });

  it("asks the public route and returns its results", async () => {
    const results = [
      { title: "implementation-guide/html > Side panel", url: "https://extension.js.org/docs/implementation-guide/html", snippet: "x", score: 9 },
    ];
    respond(200, { query: "side panel", results });

    const out = JSON.parse(await handler({ query: "side panel", limit: 20 }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("found");
    expect(out.value.results).toEqual(results);
    expect(calls[0]).toBe("https://www.extension.dev/api/docs/search?q=side%20panel&limit=8");
  });

  it("says no-match with a hint when nothing ranks", async () => {
    respond(200, { query: "zzz", results: [] });
    const out = JSON.parse(await handler({ query: "zzz" }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("no-match");
    expect(out.hint).toMatch(/extension\.js\.org\/docs/);
  });

  it("reports the rate limit with how long to wait", async () => {
    respond(429, { code: "RATE_LIMITED", message: "Too many searches.", retryAfterSeconds: 42 });
    const out = JSON.parse(await handler({ query: "manifest" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("rate-limited");
    expect(out.hint).toContain("42");
  });

  it("refuses an empty query without calling out", async () => {
    respond(200, {});
    const out = JSON.parse(await handler({ query: "  " }));

    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(calls).toHaveLength(0);
  });

  /*. */
  it("does not call an unreadable 200 a no-match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>maintenance</html>", { status: 200, headers: { "content-type": "text/html" } })),
    );
    const out = JSON.parse(await handler({ query: "side panel" }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("search-unreadable");
    expect(out.error.code).toBe("E_PLATFORM");
  });

  it("does not call a reshaped 200 a no-match", async () => {
    respond(200, { data: [] });
    const out = JSON.parse(await handler({ query: "side panel" }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("search-unreadable");
    expect(out.error.message).toMatch(/keys: data/);
  });

  it("still answers no-match for a readable empty result list", async () => {
    respond(200, { query: "zzz", results: [] });
    const out = JSON.parse(await handler({ query: "zzz" }));
    expect(out.ok).toBe(true);
    expect(out.status).toBe("no-match");
  });
});
