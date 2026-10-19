import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { handler as promote } from "../tools/release-promote";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const LISTING = `${PROJECT_ROUTE}/stores/chrome/listing`;
const CANCEL = `${PROJECT_ROUTE}/stores/chrome/submissions/sub_7f3a/cancel`;
const ROLLBACK = `${PROJECT_ROUTE}/releases/stable/rollback`;
const SETTINGS = `${PROJECT_ROUTE}/settings/build`;
const DISPATCH = `${PROJECT_ROUTE}/builds/dispatch`;
const FULL_SHA = "603fc8a6b1e2d3c4f5a6b7c8d9e0f1a2b3c4d5e6";
const PENDING = { status: 403, body: { code: "APPROVAL_PENDING", message: "This approval has not been granted yet." } };

function listingProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-round-trip-"));
  fs.writeFileSync(path.join(root, "STORE.md"), "# Store metadata\n\n## Listing\n\n- Name: PII Shield\n- Summary: Hide personal information on every open tab.\n");

  return root;
}

describe("an approval that is not granted yet reads as pending everywhere, and only a decline or an expiry reads as refused", () => {
  const platform = useProjectRoutes("extdev-round-trip-");
  let root = "";

  beforeEach(() => {
    root = listingProject();
  });

  const syncWith = (reply: { status: number; body: unknown }) => {
    platform.login();
    platform.routes[`PUT ${LISTING}`] = () => reply;

    return submit({ action: "sync-listing", browsers: ["chrome"], projectPath: root, approvalId: "apr_cz2X2", api: API }).then((out) => JSON.parse(out));
  };

  it("sync-listing with a pending approval answers ok approval-pending with the approval link", async () => {
    if (process.platform === "win32") return;

    const out = await syncWith(PENDING);

    expect(out.ok).toBe(true);
    expect(out.status).toBe("approval-pending");
    expect(out.error).toBeNull();
    expect(out.value).toMatchObject({ approvalId: "apr_cz2X2", approvalUrl: `${API}/device/approve/apr_cz2X2`, retryAfterSeconds: 10 });
    expect(out.hint).toContain("A person approves at the link");
    expect(JSON.stringify(out)).not.toMatch(/rejected|refused/i);
  });

  it("sync-listing with a declined approval answers approval-declined with the platform's words", async () => {
    if (process.platform === "win32") return;

    const out = await syncWith({ status: 403, body: { code: "APPROVAL_DENIED", message: "This approval was denied." } });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-declined");
    expect(out.error).toMatchObject({ code: "E_APPROVAL_REJECTED", name: "ApprovalDeclined", platformCode: "APPROVAL_DENIED" });
    expect(out.error.message).toContain("This approval was denied.");
  });

  it("sync-listing with an expired approval answers approval-expired", async () => {
    if (process.platform === "win32") return;

    const out = await syncWith({ status: 403, body: { code: "APPROVAL_EXPIRED", message: "This approval has expired. Request a fresh one." } });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-expired");
    expect(out.error.message).toContain("This approval has expired.");
  });

  it("sync-listing with a used approval keeps the already used answer", async () => {
    if (process.platform === "win32") return;

    const out = await syncWith({ status: 409, body: { code: "APPROVAL_CONSUMED", message: "This approval was already used. Approvals are single-use." } });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-rejected");
    expect(out.error.name).toBe("ApprovalConsumed");
    expect(out.hint).toContain("preflight");
  });

  it("submit cancel through the shared ship act answers ok approval-pending", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${CANCEL}`] = () => PENDING;

    const out = JSON.parse(await submit({ action: "cancel", submissionId: "sub_7f3a", approvalId: "apr_c", api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("approval-pending");
    expect(out.value.approvalUrl).toBe(`${API}/device/approve/apr_c`);
  });

  it("release rollback through the shared ship act answers approval-declined for a decline", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${ROLLBACK}`] = () => ({ status: 403, body: { code: "APPROVAL_DENIED", message: "This approval was denied." } });

    const out = JSON.parse(await promote({ action: "rollback", channel: "stable", approvalId: "apr_rb", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-declined");
  });

  it("builds configure with a pending approval answers ok approval-pending and writes nothing", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${SETTINGS}`] = () => ({ body: { buildSettings: {} } });
    platform.routes["GET /api/cli/approvals/apr_1"] = () => ({ body: { status: "pending", used: false } });

    const out = JSON.parse(await builds({ action: "configure", buildSettings: { firefox: { buildCommand: "pnpm build" } }, approvalId: "apr_1", api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("approval-pending");
    expect(out.value).toMatchObject({ approvalId: "apr_1", approvalUrl: `${API}/device/approve/apr_1` });
    expect(platform.sent("PUT", SETTINGS)).toHaveLength(0);
  });

  it("builds rebuild with an approval the platform reports expired answers approval-expired", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes["GET /api/cli/approvals/apr_r1"] = () => ({ body: { status: "expired", used: false } });

    const out = JSON.parse(await builds({ action: "rebuild", approvalId: "apr_r1", buildId: FULL_SHA, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-expired");
    expect(platform.sent("POST", DISPATCH)).toHaveLength(0);
  });

  it("a store submission with a declined approval answers approval-declined and submits nothing", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes["GET /api/cli/approvals/apr_s"] = () => ({ body: { status: "denied", used: false } });

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "abc1234", dryRun: false, approvalId: "apr_s", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-declined");
    expect(platform.sent("POST", "/api/cli/stores/submit")).toHaveLength(0);
  });

  it("a stable promote with a pending approval answers ok approval-pending and promotes nothing", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes["GET /api/cli/approvals/apr_p"] = () => ({ body: { status: "pending", used: false } });

    const out = JSON.parse(await promote({ buildId: "abc1234", channel: "stable", approvalId: "apr_p", api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("approval-pending");
    expect(platform.sent("POST", "/api/cli/release/promote")).toHaveLength(0);
  });
});
