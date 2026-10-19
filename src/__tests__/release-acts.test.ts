import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { TOOL_POLICY } from "../lib/tool-policy";
import { handler as promote, schema } from "../tools/release-promote";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const CUT = `${PROJECT_ROUTE}/releases/cut`;
const ROLLBACK = `${PROJECT_ROUTE}/releases/stable/rollback`;
const APPROVALS = "/api/cli/approvals";
const NOTES = "Fixes the popup on narrow screens.";
const SERVER_CUT = "Open a release pull request in acme/widget-src that bumps the extension's manifest by one minor version. It is armed to release to the Beta channel when someone merges it.";

const digest = (notes: string) =>
  crypto.createHash("sha256").update(JSON.stringify({ notes, dashboardUrl: "" })).digest("hex");

function approvalRequired(action: string, scope: Record<string, string>) {
  return {
    status: 403,
    body: {
      code: "APPROVAL_REQUIRED",
      message: "This act with a token needs a workspace owner's approval.",
      approvalRequest: { action, scope, fingerprint: actionFingerprint(action, scope) },
    },
  };
}

describe("extension_release_promote cuts a release pull request and rolls a channel back, each with an owner's approval", () => {
  const platform = useProjectRoutes("extdev-release-acts-");

  it("offers cut and rollback beside promote, and stays a shipping tool", () => {
    expect(schema.inputSchema.properties.action.enum).toEqual(["promote", "cut", "rollback"]);
    expect(schema.inputSchema.required).toEqual([]);
    expect(TOOL_POLICY.extension_release_promote.ships).toBe("always");
  });

  it("cut asks the platform first, then requests the approval the platform described, and changes nothing", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const scope = { level: "minor", channel: "beta", prTextDigest: digest(NOTES) };
    platform.routes[`POST ${CUT}`] = () => approvalRequired("extension_release.cut", scope);
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: { approvalId: "apr_cut", approvalUrl: `${API}/approve/apr_cut`, expiresAt: "2026-10-12T03:00:00Z", description: SERVER_CUT, changes: [SERVER_CUT] },
    });

    const out = JSON.parse(await promote({ action: "cut", level: "minor", channel: "Beta", releaseNotes: NOTES, api: API }));
    const [act] = platform.sent("POST", CUT);
    const [asked] = platform.sent("POST", APPROVALS);

    expect(act.body).toEqual({ level: "minor", channel: "beta", notes: NOTES });
    expect(asked.body).toMatchObject({ action: "extension_release.cut", scope, fingerprint: actionFingerprint("extension_release.cut", scope) });
    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-required");
    expect(out.value).toMatchObject({ approvalId: "apr_cut", approvalUrl: `${API}/approve/apr_cut`, description: SERVER_CUT, changes: [SERVER_CUT] });
    expect(out.error.message).toContain(SERVER_CUT);
    expect(out.error.message).not.toContain("irreversible");
    expect(out.hint).toContain("apr_cut");
  });

  it("cut the platform refuses before any approval says why and what to do, and asks nobody", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${CUT}`] = () => ({
      status: 404,
      body: { code: "UNKNOWN_CHANNEL", message: 'This project does not declare a "nightly" channel. Its channels are: stable, beta.', refusedBeforeApproval: true },
    });

    const out = JSON.parse(await promote({ action: "cut", channel: "nightly", api: API }));

    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.status).toBe("cut-refused");
    expect(out.error.platformCode).toBe("UNKNOWN_CHANNEL");
    expect(out.value.refusedBeforeApproval).toBe(true);
    expect(out.error.message).toContain("stable, beta. Nothing ran and no approval was requested.");
    expect(out.hint).toContain("create-channel");
  });

  it("cut refuses an approval request for a pull request text other than the one it sent", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${CUT}`] = () => approvalRequired("extension_release.cut", { level: "patch", prTextDigest: digest("other words") });

    const out = JSON.parse(await promote({ action: "cut", releaseNotes: NOTES, api: API }));

    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.status).toBe("cut-refused");
    expect(out.error.name).toBe("ApprovalRequestMismatch");
  });

  it("cut with an approved approval opens the pull request once and names it", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${CUT}`] = () => ({
      body: { mode: "pr", level: "patch", channel: "", currentVersion: "1.2.3", nextVersion: "1.2.4", prUrl: "https://github.com/acme/widget-src/pull/7", prNumber: 7, manifestPath: "manifest.json", autoRelease: false },
    });

    const out = JSON.parse(await promote({ action: "cut", approvalId: "apr_cut", api: API }));
    const [act] = platform.sent("POST", CUT);

    expect(act.body).toEqual({ level: "patch", approvalId: "apr_cut" });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("cut");
    expect(out.value).toMatchObject({ prUrl: "https://github.com/acme/widget-src/pull/7", nextVersion: "1.2.4" });
  });

  it("cut with an approval still pending says to approve it and call again", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${CUT}`] = () => ({ status: 403, body: { code: "APPROVAL_PENDING", message: "This approval has not been granted yet." } });

    const out = JSON.parse(await promote({ action: "cut", approvalId: "apr_cut", api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("approval-pending");
    expect(out.value).toMatchObject({ platformCode: "APPROVAL_PENDING", approvalId: "apr_cut", approvalUrl: `${API}/device/approve/apr_cut` });
    expect(out.hint).toContain("granted yet. A person approves at the link");
    expect(out.hint).toContain("Nothing was done by this call.");
  });

  it("cut whose minter is not an owner is refused at the approval request with that reason", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${CUT}`] = () => approvalRequired("extension_release.cut", { level: "patch" });
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 403,
      body: { code: "OWNER_REQUIRED", message: "Opening a release pull request with a token is a workspace owner action.", refusedBeforeApproval: true },
    });

    const out = JSON.parse(await promote({ action: "cut", api: API }));

    expect(out.status).toBe("cut-refused");
    expect(out.error.platformCode).toBe("OWNER_REQUIRED");
  });

  it("rollback needs a channel and asks nothing without one", async () => {
    const out = JSON.parse(await promote({ action: "rollback", api: API }));

    expect(out.status).toBe("bad-request");
    expect(platform.calls).toHaveLength(0);
  });

  it("rollback requests an approval for the build the platform resolved", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const scope = { channel: "stable", buildId: "1a2b3c4" };
    platform.routes[`POST ${ROLLBACK}`] = () => approvalRequired("extension_release.rollback", scope);
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: { approvalId: "apr_rb", approvalUrl: `${API}/approve/apr_rb`, description: "Roll the Stable channel of acme/widget back to build 1a2b3c4 for chrome." },
    });

    const out = JSON.parse(await promote({ action: "rollback", channel: "Stable", api: API }));
    const [asked] = platform.sent("POST", APPROVALS);

    expect(platform.sent("POST", ROLLBACK)[0].body).toEqual({});
    expect(asked.body.scope).toEqual(scope);
    expect(out.status).toBe("approval-required");
    expect(out.value.description).toContain("build 1a2b3c4");
  });

  it("rollback with no earlier build says so and points at a promote instead", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${ROLLBACK}`] = () => ({
      status: 409,
      body: { code: "NO_ROLLBACK_TARGET", message: "Nothing to roll back to, this channel has no earlier build.", refusedBeforeApproval: true },
    });

    const out = JSON.parse(await promote({ action: "rollback", channel: "stable", api: API }));

    expect(out.status).toBe("rollback-refused");
    expect(out.error.platformCode).toBe("NO_ROLLBACK_TARGET");
    expect(out.hint).toContain("extension_release_promote");
  });

  it("rollback approved that reached only some browsers says which, so it is not repeated whole", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${ROLLBACK}`] = () => ({
      body: { ok: true, status: "ok", channel: "stable", build: "1a2b3c4", rolledBackBrowsers: ["chrome"], failedBrowsers: ["firefox"] },
    });

    const out = JSON.parse(await promote({ action: "rollback", channel: "stable", approvalId: "apr_rb", api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("rolled-back-partially");
    expect(out.warnings.join(" ")).toContain("firefox");
  });

  it("promote still needs a buildId and a channel", async () => {
    platform.login();
    const out = JSON.parse(await promote({ api: API }));

    expect(out.status).toBe("bad-request");
  });
});
