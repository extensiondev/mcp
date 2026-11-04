import { describe, expect, it } from "vitest";

import { handler as builds, schema } from "../tools/builds";
import { TOOL_POLICY } from "../lib/tool-policy";
import { API, DISPATCH_ROUTE, SUITE, login, world } from "./builds-acts-harness";

describe(SUITE, () => {
  it("offers download, rebuild, configure and create-channel beside the reads, and is no longer a read-only tool", () => {
    expect(schema.inputSchema.properties.action.enum).toEqual(["list", "get", "logs", "download", "rebuild", "recheck", "configure", "create-channel", "configure-channel", "delete-channel"]);
    expect(TOOL_POLICY.extension_builds.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(TOOL_POLICY.extension_builds.ships).toBeUndefined();
    expect(TOOL_POLICY.extension_builds.untrusted).toBe(true);
  });

  it("rebuild dispatches as the agent, never forces, and says how to follow the run", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`POST ${DISPATCH_ROUTE}`] = () => ({
      body: { ok: true, branch: "main", commit: "603fc8a", browsers: "chrome,firefox", origin: "mcp" },
    });

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "603fc8a", buildEnv: "production", api: API }));
    const dispatch = world.calls.find((call) => call.method === "POST");

    expect(dispatch?.url).toBe(`${API}${DISPATCH_ROUTE}`);
    expect(dispatch?.body).toEqual({ origin: "mcp", buildEnv: "production", commitSha: "603fc8a" });
    expect(dispatch?.auth).toBe("Bearer claims.sig");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("rebuild-dispatched");
    expect(out.value.outcome).toMatchObject({ recorded: false, source: "platform-record" });
    expect(out.value.links.map((link: { kind: string }) => link.kind)).toEqual(["build"]);
    expect(out.value).toMatchObject({ action: "rebuild", commit: "603fc8a", branch: "main", browsers: ["chrome", "firefox"], buildEnv: "production" });
    expect(out.hint).toContain("real build");
    expect(out.hint).toContain('action:"get"');
    expect(out.value.follow).toMatchObject({ list: { action: "list" }, get: { action: "get", buildId: "603fc8a" } });
  });

  it("rebuild refuses an unknown build environment before asking the platform", async () => {
    login();

    const out = JSON.parse(await builds({ action: "rebuild", buildEnv: "qa", api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(world.calls).toHaveLength(0);
  });

  it("rebuild passes on the burst cap with the wait the platform asked for", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`POST ${DISPATCH_ROUTE}`] = () => ({
      body: { code: "burst_cap", message: "Too many builds in the last hour." },
      status: 429,
      headers: { "Retry-After": "120" },
    });

    const out = JSON.parse(await builds({ action: "rebuild", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("rate-limited");
    expect(out.error.platformCode).toBe("burst_cap");
    expect(out.value.retryAfterSeconds).toBe(120);
    expect(out.hint).toContain("120 seconds");
  });

  it("rebuild that would replace a live channel's artifacts names the matching environment", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`POST ${DISPATCH_ROUTE}`] = () => ({
      body: { code: "REBUILD_REPLACES_LIVE_ARTIFACT", message: "Commit 603fc8a is live on stable (requires production)." },
      status: 409,
    });

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "603fc8a", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("refused");
    expect(out.error.platformCode).toBe("REBUILD_REPLACES_LIVE_ARTIFACT");
    expect(out.hint).toContain("buildEnv");
    expect(world.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("rebuild of the commit a Stable channel serves says to rebuild another commit or release a new build first", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`POST ${DISPATCH_ROUTE}`] = () => ({
      body: { code: "BUILD_ENV_SERVED", message: "Commit 603fc8a is what stable serves, and a Preview rebuild would change the environment recorded for the build stable points at. Rebuild another commit for Preview, or release a new build to stable first." },
      status: 409,
    });

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "603fc8a", api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.platformCode).toBe("BUILD_ENV_SERVED");
    expect(out.hint).toContain("Rebuild another commit for Preview, or release a new build to");
    expect(world.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
});
