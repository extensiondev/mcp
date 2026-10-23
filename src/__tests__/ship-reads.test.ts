import { describe, expect, it } from "vitest";

import { tokenRefusal } from "../lib/project-api";
import { handler as status, schema } from "../tools/release-status";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

describe("extension_release_status reads the latest release runs, the Chrome rollout and whether a cut could build", () => {
  const platform = useProjectRoutes("extdev-ship-reads-");

  it("offers runs, rollout and cut as sections", () => {
    expect(schema.inputSchema.properties.include.items.enum).toEqual(["releases", "stores", "history", "runs", "rollout", "cut", "listing"]);
  });

  it("runs reads the newest release runs since a date, as the owner's read", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${PROJECT_ROUTE}/releases/promotion-runs`] = () => ({
      body: { since: "2026-10-05T00:00:00.000Z", recent: [{ runId: 1, name: "Release chrome stable", status: "completed", conclusion: "success", htmlUrl: "https://github.com/m/r/actions/runs/1", createdAt: "2026-10-11T10:00:00Z" }] },
    });

    const out = JSON.parse(await status({ include: ["runs"], since: "2026-10-05", api: API }));
    const call = platform.calls.find((c) => c.path.endsWith("/promotion-runs"));

    expect(new URL(call!.url).searchParams.get("since")).toBe("2026-10-05");
    expect(out.ok).toBe(true);
    expect(out.value.runs.value).toMatchObject({ since: "2026-10-05T00:00:00.000Z", recent: [{ runId: 1, conclusion: "success" }] });
  });

  it("runs read by a login whose minter is not an owner says it needs an owner", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${PROJECT_ROUTE}/releases/promotion-runs`] = () => ({ status: 403, body: { code: "OWNER_REQUIRED", message: "Owners only." } });

    const out = JSON.parse(await status({ include: ["runs"], api: API }));

    expect(out.value.runs.status).toBe("needs-owner");
  });

  it("rollout reads the Chrome staged rollout and whether it can be raised", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${PROJECT_ROUTE}/stores/chrome/rollout`] = () => ({
      body: { ok: true, supported: true, rollout: { store: "chrome", stagedPublish: true, percentage: 10, minPercentage: 1, maxPercentage: 100, minWeeklyUsers: 10000, canRaise: true } },
    });

    const out = JSON.parse(await status({ include: ["rollout"], api: API }));

    expect(out.value.rollout.value.rollout).toMatchObject({ stagedPublish: true, percentage: 10, canRaise: true });
    expect(out.value.rollout.hint).toContain("rollout");
  });

  it("cut reads whether a release pull request opened now could build after merging", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${PROJECT_ROUTE}/releases/cut`] = () => ({ body: { allowed: true, limit: 350, used: 12, dispatchDisabled: false } });

    const out = JSON.parse(await status({ include: ["cut"], api: API }));

    expect(out.value.cut.value).toMatchObject({ allowed: true, limit: 350, used: 12, dispatchDisabled: false });
  });
});

describe("a route closed to logins names the one that is open, or the person who can act", () => {
  it.each([
    ["PROMOTE_THROUGH_CLI_ROUTE", "extension_release_promote"],
    ["SUBMIT_THROUGH_CLI_ROUTE", "extension_submit"],
    ["RELEASE_DELETE_NEEDS_A_PERSON", "console"],
  ])("%s", (code, next) => {
    const known = tokenRefusal(code);

    expect(known?.status).toBe("refused");
    expect(known?.hint).toContain(next);
  });
});
