// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { buildName, buildNumberOf } from "../lib/builds-list-row";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const SHA = "603fc8a";
const COMMIT = "603fc8ab0ff0ac1dae1c598428ce49ad43081c98";
const BUILD_ROUTE = `${PROJECT_ROUTE}/builds/${SHA}`;

const row = (extra: Record<string, unknown> = {}) => ({
  id: SHA,
  buildId: SHA,
  commit: COMMIT,
  status: "success",
  buildEnv: "staging",
  startedAt: "2026-11-02T10:00:00.000Z",
  completedAt: "2026-11-02T10:01:06.000Z",
  duration: "1m 6s",
  browsers: ["chrome"],
  ...extra,
});

const detail = (extra: Record<string, unknown> = {}) => ({
  id: SHA,
  buildId: SHA,
  commit: COMMIT,
  status: "success",
  browsers: [{ name: "chrome", status: "success" }],
  ...extra,
});

describe("extension_builds names a numbered build as Build #n with its sha, and an unnumbered one by its sha alone", () => {
  const platform = useProjectRoutes("extdev-builds-numbered-");

  it.each([
    [{ buildNumber: 12 }, 12],
    [{}, null],
    [{ buildNumber: 0 }, null],
    [{ buildNumber: -3 }, null],
    [{ buildNumber: 1.5 }, null],
    [{ buildNumber: "12" }, null],
    [{ buildNumber: null }, null],
    ["not a row", null],
  ])("reads the number only from a positive whole buildNumber (%j)", (input, expected) => {
    expect(buildNumberOf(input)).toBe(expected);
  });

  it("never prints Build #undefined, whatever the number read", () => {
    expect(buildName(SHA, 12)).toBe(`Build #12 (${SHA})`);
    expect(buildName(SHA, null)).toBe(`Build ${SHA}`);
    expect(buildName(SHA, null, "build")).toBe(`build ${SHA}`);
    expect(buildName(SHA, null, "")).toBe(SHA);
    expect(buildName(SHA, buildNumberOf({ buildNumber: undefined }))).not.toContain("#");
  });

  it("list carries buildNumber on a numbered row, leaves it off an unnumbered one, and names the latest by its number", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${PROJECT_ROUTE}/builds`] = () => ({
      body: { items: [row({ buildNumber: 12 }), row({ id: "4478aff", buildId: "4478aff", commit: "4478aff0ff0ac1dae1c598428ce49ad43081c98" })] },
    });

    const out = JSON.parse(await builds({ action: "list", api: API }));

    expect(out.value.builds[0]).toMatchObject({ buildId: SHA, buildNumber: 12, sha: COMMIT });
    expect(out.value.builds[1]).not.toHaveProperty("buildNumber");
    expect(out.hint).toContain(`the latest is Build #12 (${SHA}, success)`);
  });

  it("list names the latest by its sha alone when the platform minted no number", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${PROJECT_ROUTE}/builds`] = () => ({ body: { items: [row()] } });

    const out = JSON.parse(await builds({ action: "list", api: API }));

    expect(out.hint).toContain(`the latest is ${SHA} (success)`);
    expect(out.hint).not.toContain("#");
  });

  it.each([
    [{ buildNumber: 12 }, `Build #12 (${SHA}) is success`],
    [{}, `Build ${SHA} is success`],
  ])("get leads its hint with the build's name (%j)", async (extra, lead) => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${BUILD_ROUTE}`] = () => ({ body: detail(extra) });
    platform.routes[`GET ${BUILD_ROUTE}/usage`] = () => ({ body: { markdown: null } });
    platform.routes[`GET ${BUILD_ROUTE}/artifacts`] = () => ({ body: [] });
    platform.routes[`GET ${BUILD_ROUTE}/integrity/chrome`] = () => ({ body: { ok: true, checks: [] } });

    const out = JSON.parse(await builds({ action: "get", buildId: SHA, api: API }));

    expect(out.hint.startsWith(lead)).toBe(true);
    if ("buildNumber" in extra) expect(out.value.build.buildNumber).toBe(12);
    else expect(out.value.build).not.toHaveProperty("buildNumber");
  });

  it("logs reads the number from the build's own record beside the log lines", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${BUILD_ROUTE}/logs`] = () => ({ body: { buildId: SHA, run: { status: "completed", conclusion: "cancelled", failedJob: null }, items: [] } });
    platform.routes[`GET ${BUILD_ROUTE}`] = () => ({ body: detail({ buildNumber: 12, status: "cancelled" }) });

    const out = JSON.parse(await builds({ action: "logs", buildId: SHA, api: API }));

    expect(out.value.buildNumber).toBe(12);
    expect(out.value.sayToPerson).toContain(`Build #12 (${SHA}) was canceled by the platform`);
  });

  it("logs keeps the sha alone when the record cannot be read", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${BUILD_ROUTE}/logs`] = () => ({ body: { buildId: SHA, run: { status: "completed", conclusion: "success", failedJob: null }, items: [] } });

    const out = JSON.parse(await builds({ action: "logs", buildId: SHA, api: API }));

    expect(out.value).not.toHaveProperty("buildNumber");
    expect(out.hint).toContain(`No log lines are recorded for build ${SHA} yet`);
    expect(out.hint).not.toContain("#");
  });

  it("rebuild names the build by the number its record carries once the record confirms", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/builds/dispatch`] = () => ({
      body: { ok: true, branch: "main", commit: SHA, browsers: "chrome", origin: "mcp", deploymentId: "d-1", dispatchedAt: "2026-11-02T10:00:00.000Z", runId: 7001 },
    });

    platform.routes[`GET ${BUILD_ROUTE}`] = () => ({ body: detail({ buildNumber: 13, runId: 7001 }) });

    const out = JSON.parse(await builds({ action: "rebuild", buildId: SHA, waitSeconds: 0, api: API }));

    expect(out.status).toBe("built");
    expect(out.value.buildNumber).toBe(13);
    expect(out.hint).toContain(`The platform's record of Build #13 (${SHA}) now reads success`);
  });

  it("rebuild keeps the sha alone while the record carries no number", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/builds/dispatch`] = () => ({
      body: { ok: true, branch: "main", commit: SHA, browsers: "chrome", origin: "mcp", deploymentId: "d-1", dispatchedAt: "2026-11-02T10:00:00.000Z" },
    });

    const out = JSON.parse(await builds({ action: "rebuild", buildId: SHA, waitSeconds: 0, api: API }));

    expect(out.status).toBe("rebuild-dispatched");
    expect(out.value).not.toHaveProperty("buildNumber");
    expect(JSON.stringify(out)).not.toContain("#");
  });
});
