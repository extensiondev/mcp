import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BULLET_KEYS, LISTING_SECTION, PRIVACY_SECTION, STORE_SECTIONS, SUBSECTION_KEYS } from "../lib/store-md-declarations";
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

  it("tells an agent holding only the schema what it searches, what comes back, and what an empty answer means", () => {
    expect(schema.description).toMatch(
      /for a WebExtension API, a manifest key, a permission or a browser difference/,
    );

    expect(schema.description).toMatch(/Answers matching pages with URLs/);
    expect(schema.description).toMatch(/An empty answer means the docs hold no match\.$/);
  });

  it("asks the public route and returns its results", async () => {
    const results = [
      { title: "implementation-guide/html > Side panel", url: "https://extension.js.org/docs/implementation-guide/html", snippet: "x", score: 9 },
    ];
    respond(200, { query: "side panel", results });

    const out = JSON.parse(await handler({ query: "side panel", limit: 8 }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("found");
    expect(out.value.results).toEqual(results);
    expect(calls[0]).toBe("https://www.extension.dev/api/docs/search?q=side%20panel&limit=8");
  });

  it("921: answers the STORE.md format from the parser's own lists, first and without calling out, when the query names the file", async () => {
    respond(200, { query: "STORE.md", results: [] });

    for (const query of ["STORE.md", "what goes in store.md for Firefox?"]) {
      const out = JSON.parse(await handler({ query }));
      const [first] = out.value.results;

      expect(out.ok).toBe(true);
      expect(out.status).toBe("found");
      expect(out.value.results).toHaveLength(1);
      expect(first.title).toBe("STORE.md format");
      expect(first.url).toBe("https://extension.js.org/docs/workflows/store-metadata");

      for (const section of [LISTING_SECTION, PRIVACY_SECTION, ...Object.values(STORE_SECTIONS)]) {
        expect(first.snippet).toContain(`\n${section}\n`);
      }

      for (const key of SUBSECTION_KEYS) expect(first.snippet).toContain(key.heading);
      for (const key of BULLET_KEYS) expect(first.snippet).toContain(`- ${key.line}:`);

      expect(first.snippet).toContain("### Permissions justification (chrome, edge): one `- <permission>: <reason>` bullet each");
      expect(first.snippet).toContain("- License: (firefox)");
      expect(first.snippet).not.toMatch(/\bnone\b|collects nothing|no data/i);
      expect(first.snippet.length).toBeLessThan(3400);
    }

    expect(calls).toHaveLength(0);
  });

  it("921: still asks the public route for a query that only names a store", async () => {
    respond(200, { query: "chrome web store review", results: [] });
    await handler({ query: "chrome web store review" });

    expect(calls).toHaveLength(1);
  });

  it("says no-match with a hint when nothing ranks", async () => {
    respond(200, { query: "zzz", results: [] });
    const out = JSON.parse(await handler({ query: "zzz" }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("no-match");
    expect(out.hint).toMatch(/extension\.js\.org\/docs/);
    expect(out.hint).toMatch(/answer from memory only after that, and say the docs had no page/);
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

  it("932: says on a found answer that the hold kept platform pages back, and passes the count through", async () => {
    const results = [{ title: "contracts/error-codes", url: "https://extension.js.org/docs/contracts/error-codes", snippet: "x", score: 3 }];
    respond(200, { query: "UNKNOWN_CHANNEL", results, heldBack: { platformPages: 12 } });
    const out = JSON.parse(await handler({ query: "UNKNOWN_CHANNEL" }));

    expect(out.status).toBe("found");
    expect(out.value.results).toEqual(results);
    expect(out.value.heldBack).toEqual({ platformPages: 12 });
    expect(out.hint).toBe(
      "The public hold is on: the platform held back 12 of its own platform pages from these results server-side, so this list is partial and an extension.dev topic can be absent for that reason alone.",
    );
  });

  it("932: says the same on no-match after the no-match guidance when the route sends the count", async () => {
    respond(200, { query: "preview and stable channels", results: [], heldBack: { platformPages: 1 } });
    const out = JSON.parse(await handler({ query: "preview and stable channels" }));

    expect(out.status).toBe("no-match");
    expect(out.value.heldBack).toEqual({ platformPages: 1 });
    expect(out.hint).toBe(
      "No page matched. Try fewer or different words, or browse https://extension.js.org/docs; answer from memory only after that, and say the docs had no page. The public hold is on: the platform held back 1 of its own platform pages from these results server-side, so this list is partial and an extension.dev topic can be absent for that reason alone.",
    );
  });

  it("932: says nothing about the hold on a found answer when the route sends no count, a zero or a value that is not a count", async () => {
    const results = [{ title: "a", url: "https://extension.js.org/docs/a", snippet: "x", score: 3 }];

    for (const heldBack of [undefined, { platformPages: 0 }, { platformPages: "3" }, { platformPages: -1 }, { platformPages: 1.5 }, "yes", null]) {
      respond(200, { query: "a", results, ...(heldBack === undefined ? {} : { heldBack }) });
      const out = JSON.parse(await handler({ query: "a" }));

      expect(out.status).toBe("found");
      expect(out.hint).toBeUndefined();
      expect(out.value).toEqual({ query: "a", results });
    }
  });

  it("932: keeps the conditional hold sentence on no-match against a route that sends no count", async () => {
    respond(200, { query: "zzz", results: [] });
    const out = JSON.parse(await handler({ query: "zzz" }));

    expect(out.value).toEqual({ query: "zzz", results: [] });
    expect(out.hint).toBe(
      "No page matched. Try fewer or different words, or browse https://extension.js.org/docs; answer from memory only after that, and say the docs had no page. While the public hold is on, the platform filters its own platform pages out of these results server-side, so an extension.dev topic can be absent for that reason alone.",
    );
  });
});
