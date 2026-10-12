import { describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const DEPLOYMENT = "0f6c2a1e-1111-4222-8333-444455556666";
const RUN_URL = "https://github.com/mirror/repo/actions/runs/38194405984";
const DISPATCHED_AT = "2026-10-12T02:05:07.000Z";

describe("extension_builds hands an agent this rebuild's run, and the reads name the run behind each build", () => {
  const platform = useProjectRoutes("extdev-builds-run-");

  const dispatched = (extra: Record<string, unknown>) => {
    platform.routes[`POST ${PROJECT_ROUTE}/builds/dispatch`] = () => ({
      body: { ok: true, branch: "main", commit: "603fc8a", browsers: "chrome,firefox", origin: "mcp", deploymentId: DEPLOYMENT, dispatchedAt: DISPATCHED_AT, ...extra },
    });
  };

  it("rebuild returns the run it started and says to follow that run, not the build id alone", async () => {
    if (process.platform === "win32") return;

    platform.login();
    dispatched({ runCorrelation: "run-name", runId: 38194405984, runUrl: RUN_URL });

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "603fc8a", api: API }));

    expect(out.status).toBe("dispatched");
    expect(out.value).toMatchObject({
      deploymentId: DEPLOYMENT,
      dispatchedAt: DISPATCHED_AT,
      runCorrelation: "run-name",
      runId: 38194405984,
      runUrl: RUN_URL,
    });

    expect(out.value.follow.get).toEqual({ action: "get", buildId: "603fc8a" });
    expect(out.value.follow.match).toEqual({ runId: 38194405984 });
    expect(out.hint).toContain("runId 38194405984");
    expect(out.hint).toContain(RUN_URL);
  });

  it("rebuild whose run has not shown up yet says to match the deployment id or a later start", async () => {
    if (process.platform === "win32") return;

    platform.login();
    dispatched({ runCorrelation: "pending" });

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "603fc8a", api: API }));

    expect(out.value.runId).toBeUndefined();
    expect(out.value.runCorrelation).toBe("pending");
    expect(out.value.follow.match).toEqual({ deploymentId: DEPLOYMENT, startedAfter: DISPATCHED_AT });
    expect(out.hint).toContain(DEPLOYMENT);
    expect(out.hint).toContain(`after ${DISPATCHED_AT}`);
    expect(out.hint).toContain("same build id");
  });

  it("rebuild against a platform that names no run still says the build id is reused", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/builds/dispatch`] = () => ({
      body: { ok: true, branch: "main", commit: "603fc8a", browsers: "chrome", origin: "mcp" },
    });

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "603fc8a", api: API }));

    expect(out.value.follow.match).toBeUndefined();
    expect(out.hint).toContain("same build id");
  });

  it("list rows carry the run, its deployment and when it started", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${PROJECT_ROUTE}/builds`] = () => ({
      body: {
        items: [
          { buildId: "603fc8a", commit: "603fc8ab0ff0ac1dae1c598428ce49ad43081c98", status: "building", startedAt: "2026-10-12T02:05:09Z", runId: 38194405984, deploymentId: DEPLOYMENT, browsers: ["chrome"] },
        ],
      },
    });

    const out = JSON.parse(await builds({ action: "list", api: API }));

    expect(out.value.builds[0]).toMatchObject({ runId: 38194405984, deploymentId: DEPLOYMENT, startedAt: "2026-10-12T02:05:09Z" });
  });

  it("get names the run behind the build it shows", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${PROJECT_ROUTE}/builds/603fc8a`] = () => ({
      body: { buildId: "603fc8a", status: "building", startedAt: "2026-10-12T02:05:09Z", runId: 38194405984, runUrl: RUN_URL, deploymentId: DEPLOYMENT, browsers: [] },
    });

    const out = JSON.parse(await builds({ action: "get", buildId: "603fc8a", api: API }));

    expect(out.value.run).toEqual({ runId: 38194405984, runUrl: RUN_URL, deploymentId: DEPLOYMENT, startedAt: "2026-10-12T02:05:09Z" });
  });

  it("a rebuild refused for replacing live artifacts never sends the agent to a console page that cannot force it", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/builds/dispatch`] = () => ({
      status: 403,
      body: { code: "REBUILD_FORCE_NEEDS_A_PERSON", message: "A token cannot force a rebuild." },
    });

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "603fc8a", api: API }));

    expect(out.hint).not.toContain("Builds page");
    expect(out.hint).toContain("Replace and rebuild");
  });
});
