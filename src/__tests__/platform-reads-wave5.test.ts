import { describe, it, expect } from "vitest";

import {
  buildIndexShapeProblem,
  channelsShapeProblem,
  requireShape,
} from "../lib/registry";
import { fetchLoginConfig } from "../lib/login-flow";
import { listArtifacts } from "../lib/artifacts-api";

const json = (body: unknown, status = 200) =>
  (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("wave 5: platform reads that cannot be read say so", () => {
  it("86: a channels map or build index of the wrong shape is unreadable, not empty", () => {
    expect(channelsShapeProblem({ stable: { sha: "abc" } })).toBeNull();
    expect(channelsShapeProblem({})).toBeNull();
    expect(channelsShapeProblem([])).toMatch(/not a channels map/);
    expect(channelsShapeProblem({ stable: "abc" })).toMatch(/stable is not an object/);
    expect(buildIndexShapeProblem({ items: [] })).toBeNull();
    expect(buildIndexShapeProblem({ builds: [] })).toMatch(/no items list/);
    const read = requireShape({ ok: true, json: { builds: [] } }, buildIndexShapeProblem);
    expect(read.ok).toBe(false);
    expect((read as { message: string }).message).toMatch(/answered 200 but the body has no items list/);
  });

  it("84d: an unparseable login config is an error, not 'batch unsupported'", async () => {
    await expect(fetchLoginConfig("https://api.test", json("<html>gateway</html>"))).rejects.toThrow(/could not be read.*unknown/);
    const ok = await fetchLoginConfig("https://api.test", json({ deviceCodeUrl: "/a", deviceTokenUrl: "/b" }));
    expect(ok.deviceCodeUrl).toBe("/a");
  });

  it("55: a listing without its list is an error, and rows without an id are counted out", async () => {
    const missing = await listArtifacts({ token: "t", api: "https://www.extension.dev", fetchImpl: json({ count: 0 }) } as never);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toMatch(/without an artifacts list/);

    const partial = await listArtifacts({
      token: "t",
      api: "https://www.extension.dev",
      fetchImpl: json({ artifacts: [{ artifactId: `gen_${"a".repeat(64)}` }, { nope: 1 }], truncated: false }),
    } as never);
    expect(partial.ok, JSON.stringify(partial)).toBe(true);

    if (partial.ok) {
      expect(partial.data.artifacts).toHaveLength(1);
      expect(partial.data.malformedRows).toBe(1);
    }
  });
});
