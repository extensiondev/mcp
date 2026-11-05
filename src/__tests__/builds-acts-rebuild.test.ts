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

  it("rebuild refused for a spent month prints the platform's priced sentence and its upgrade link as they came", async () => {
    if (process.platform === "win32") return;

    const said = "This build was refused and nothing was dispatched: monthly build limit of 25 reached. Retry in 3600 seconds. Pro is $29 per workspace per month and includes 350 builds a month.";
    login();
    world.routes[`POST ${DISPATCH_ROUTE}`] = () => ({
      body: { code: "monthly_cap", message: said, upgradeUrl: "https://www.extension.dev/pricing" },
      status: 429,
    });

    const out = JSON.parse(await builds({ action: "rebuild", api: API }));

    expect(out.status).toBe("rate-limited");
    expect(out.error.platformCode).toBe("monthly_cap");
    expect(out.hint).toBe(said);
    expect(out.value.upgradeUrl).toBe("https://www.extension.dev/pricing");
  });

  it("rebuild refused for a spent month with no sentence keeps the fallback and names no upgrade link", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`POST ${DISPATCH_ROUTE}`] = () => ({ body: { code: "monthly_cap" }, status: 429 });

    const out = JSON.parse(await builds({ action: "rebuild", api: API }));

    expect(out.hint).toContain("The workspace's build allowance for this month is spent, so nothing was dispatched.");
    expect(out.value.upgradeUrl).toBeUndefined();
  });

  it("rebuild refused for the wrong environment prints the platform's sentence, price included", async () => {
    if (process.platform === "win32") return;

    const said = "This build was produced for Preview, but the Stable channel takes Stable builds. Rebuild this commit for Stable (Builds, Rebuild), then release it. The rebuild spends 1 build from the monthly allowance.";
    login();
    world.routes[`POST ${DISPATCH_ROUTE}`] = () => ({ body: { code: "BUILD_ENV_MISMATCH", message: said }, status: 409 });

    const out = JSON.parse(await builds({ action: "rebuild", api: API }));

    expect(out.error.platformCode).toBe("BUILD_ENV_MISMATCH");
    expect(out.hint).toBe(said);
  });
});
