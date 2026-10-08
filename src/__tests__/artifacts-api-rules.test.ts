import { describe, expect, it } from "vitest";

import { wwwRevokeUrl } from "../lib/artifacts-api";

describe("a revoke handle works with one plain DELETE: the apex host answers DELETE with a redirect, so it is rewritten to www and every other host passes through", () => {
  it("rewrites the apex to the www host", () => {
    expect(wwwRevokeUrl("https://extension.dev/api/artifacts/gen_abc")).toBe(
      "https://www.extension.dev/api/artifacts/gen_abc",
    );
  });

  it("leaves localhost, a self-hosted base and a non-URL untouched", () => {
    expect(wwwRevokeUrl("http://localhost:3000/api/artifacts/gen_abc")).toBe("http://localhost:3000/api/artifacts/gen_abc");
    expect(wwwRevokeUrl("https://platform.example/api/artifacts/gen_abc")).toBe("https://platform.example/api/artifacts/gen_abc");
    expect(wwwRevokeUrl("not a url")).toBe("not a url");
  });
});
