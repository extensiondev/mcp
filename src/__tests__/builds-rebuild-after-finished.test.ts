// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { API, DISPATCH_ROUTE, login, world } from "./builds-acts-harness";

const BUILD_ROUTE = "/api/projects/prj_probe/builds/6fb8b3e";
const STARTED = "2026-11-06T19:26:25.000Z";
const FULL_SHA = "6fb8b3e1234567890abcdef1234567890abcdef1";

function running(state: string, startedAt: string | null = STARTED) {
  return {
    body: {
      code: "BUILD_ALREADY_RUNNING",
      message: "Commit 6fb8b3e on main is already building, so no rebuild was started and nothing was spent.",
      trackUrl: "https://console.extension.dev/acme/widget/builds/6fb8b3e",
      details: { state, branch: "main", commit: "6fb8b3e", buildId: "6fb8b3e", startedAt, dispatched: false },
    },
    status: 409,
  };
}

const DISPATCHED = { body: { ok: true, branch: "main", commit: "6fb8b3e", browsers: "chrome,firefox", origin: "mcp" } };

function record(status: string) {
  return { body: { buildId: "6fb8b3e", buildNumber: 16, status, startedAt: STARTED } };
}

function refuseThenDispatch() {
  let posts = 0;
  world.routes[`POST ${DISPATCH_ROUTE}`] = () => (posts++ === 0 ? running("in_progress") : DISPATCHED);
}

function dispatches() {
  return world.calls.filter((call) => call.method === "POST" && call.url.endsWith("/builds/dispatch"));
}

describe("extension_builds rebuild after the build the platform refused over has finished", () => {
  it("sends the rebuild once the record reads success, names the target channel and never says it is still building", async () => {
    if (process.platform === "win32") return;

    login();
    refuseThenDispatch();
    world.routes[`GET ${BUILD_ROUTE}`] = () => record("success");

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "6fb8b3e", waitSeconds: 0, api: API }));

    expect(dispatches()).toHaveLength(2);
    expect(dispatches()[1]?.body).toEqual({ origin: "mcp", commitSha: "6fb8b3e" });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("rebuild-dispatched");
    expect(out.value).toMatchObject({ action: "rebuild", commit: "6fb8b3e", buildEnv: "staging", channel: "preview", browsers: ["chrome", "firefox"] });
    expect(out.value.earlierBuild).toEqual({ name: "Build #16 (6fb8b3e)", state: "in_progress", startedAt: STARTED, status: "success" });
    expect(out.hint).toContain("Build #16 (6fb8b3e) ran (since 2026-11-06T19:26:25.000Z); that build has finished and its record reads success");
    expect(out.hint).not.toMatch(/already building|already queued|would cancel/);
    expect(out.hint).toContain("This rebuild is for Preview (buildEnv staging, the default)");
    expect(out.hint).toContain("buildEnv production");
    expect(out.hint).toContain("Rebuild for Stable");
  });

  it("sends the rebuild once the record reads failed", async () => {
    if (process.platform === "win32") return;

    login();
    refuseThenDispatch();
    world.routes[`GET ${BUILD_ROUTE}`] = () => record("failed");

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "6fb8b3e", waitSeconds: 0, api: API }));

    expect(dispatches()).toHaveLength(2);
    expect(out.ok).toBe(true);
    expect(out.status).toBe("rebuild-dispatched");
    expect(out.value.earlierBuild).toMatchObject({ status: "failed" });
    expect(out.hint).toContain("its record reads failed");
  });

  it("still refuses while the record reads running, and that answer never says finished", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`POST ${DISPATCH_ROUTE}`] = () => running("in_progress");
    world.routes[`GET ${BUILD_ROUTE}`] = () => record("in_progress");

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "6fb8b3e", buildEnv: "production", waitSeconds: 0, api: API }));

    expect(dispatches()).toHaveLength(1);
    expect(out.ok).toBe(true);
    expect(out.status).toBe("build-already-running");
    expect(out.value).toMatchObject({ dispatched: false, buildEnv: "production", channel: "stable", running: { state: "in_progress", startedAt: STARTED } });
    expect(out.value.outcome).toMatchObject({ recorded: false, status: "in_progress" });
    expect(out.hint).toContain("Build #16 (6fb8b3e) of acme/widget is already building (since 2026-11-06T19:26:25.000Z)");
    expect(out.hint).toContain("once it ends, call this again and the rebuild goes out");
    expect(out.hint).toContain("This rebuild is for Stable (buildEnv production)");
    expect(out.hint).not.toMatch(/finished/);
  });

  it("refuses with the platform's word when the second send is held as running after the record read finished", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`POST ${DISPATCH_ROUTE}`] = () => running("in_progress");
    world.routes[`GET ${BUILD_ROUTE}`] = () => record("success");

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "6fb8b3e", waitSeconds: 0, api: API }));

    expect(dispatches()).toHaveLength(2);
    expect(out.ok).toBe(false);
    expect(out.status).toBe("build-already-running");
    expect(out.error).toMatchObject({ code: "E_PLATFORM", name: "BuildsRefused", platformCode: "BUILD_ALREADY_RUNNING" });
    expect(out.error.message).toContain("a second time as in flight (in_progress (since 2026-11-06T19:26:25.000Z)) while its own record of Build #16 (6fb8b3e) reads success");
    expect(out.value).toMatchObject({ dispatched: false, channel: "preview", earlierBuild: { name: "Build #16 (6fb8b3e)", status: "success" } });
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "success" });
    expect(out.hint).toContain("Nothing was dispatched and nothing was spent by either try");
    expect(out.hint).toContain("which offers Preview and Stable");
    expect(out.hint).not.toMatch(/already building|would cancel/);
  });

  it("carries buildEnv production to the second send and names Stable as the target", async () => {
    if (process.platform === "win32") return;

    login();
    refuseThenDispatch();
    world.routes[`GET ${BUILD_ROUTE}`] = () => record("success");

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "6fb8b3e", buildEnv: "production", waitSeconds: 0, api: API }));

    expect(dispatches().map((call) => call.body)).toEqual([
      { origin: "mcp", buildEnv: "production", commitSha: "6fb8b3e" },
      { origin: "mcp", buildEnv: "production", commitSha: "6fb8b3e" },
    ]);

    expect(out.status).toBe("rebuild-dispatched");
    expect(out.value).toMatchObject({ buildEnv: "production", channel: "stable" });
    expect(out.hint).toContain("This rebuild is for Stable (buildEnv production), the build a store submission or a Stable release takes");
    expect(out.hint).not.toContain("the default)");
  });

  it("follows the approval rules a rebuild already has when the second send asks for one", async () => {
    if (process.platform === "win32") return;

    login();
    const approvalRequest = {
      action: "extension_builds.rebuild",
      scope: { commit: FULL_SHA, buildEnv: "staging" },
      fingerprint: crypto.createHash("sha256").update(`extension_builds.rebuild\nbuildEnv=staging\ncommit=${FULL_SHA}`).digest("hex"),
    };

    let posts = 0;
    world.routes[`POST ${DISPATCH_ROUTE}`] = () => (posts++ === 0 ? running("queued", null) : { body: { code: "APPROVAL_REQUIRED", message: "needs approval", approvalRequest }, status: 403 });
    world.routes[`GET ${BUILD_ROUTE}`] = () => record("success");
    world.routes["POST /api/cli/approvals"] = () => ({
      status: 201,
      body: { approvalId: "apr_457", approvalUrl: "http://localhost:3100/device/approve/apr_457", expiresAt: "2026-11-07T20:00:00.000Z", description: "Rebuild widget at 6fb8b3e for staging." },
    });

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "6fb8b3e", waitSeconds: 0, api: API }));
    const asked = world.calls.find((call) => call.method === "POST" && call.url.endsWith("/api/cli/approvals"));

    expect(dispatches()).toHaveLength(2);
    expect(asked?.body).toMatchObject(approvalRequest);
    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-required");
    expect(out.value).toMatchObject({ approvalId: "apr_457" });
  });
});
