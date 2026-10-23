import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { handler as workspace, schema } from "../tools/workspace";
import { VISIBILITY_ACTION } from "../tools/workspace-visibility";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const VISIBILITY = `${PROJECT_ROUTE}/visibility`;
const APPROVALS = "/api/cli/approvals";

const PUBLISHED = { indexPublished: true, metaRepublished: true, channelsRewritten: true, exposurePublished: true };

function approvalRequired(scope: Record<string, string>) {
  return {
    status: 403,
    body: {
      code: "APPROVAL_REQUIRED",
      message: "Making a project public needs a workspace owner's approval.",
      approvalRequest: { action: VISIBILITY_ACTION, scope, fingerprint: actionFingerprint(VISIBILITY_ACTION, scope) },
      changes: ["visibility: private -> public"],
    },
  };
}

describe("extension_workspace set-visibility makes a project private as a plain call and keeps public on the approve page", () => {
  const platform = useProjectRoutes("extdev-workspace-visibility-");

  it("names set-visibility with its visibility and approvalId inputs", () => {
    const properties = schema.inputSchema.properties as Record<string, any>;

    expect(schema.inputSchema.properties.action.enum).toContain("set-visibility");
    expect(properties.visibility.enum).toEqual(["private", "public"]);
    expect(properties.visibility.description).toMatch(/plain call under the owner's own token/);
    expect(properties.visibility.description).toMatch(/approve page/);
    expect(properties.approvalId.description).toContain("set-visibility public");
    expect(schema.description).toContain("set-visibility");
    expect(schema.description).not.toContain("This is read-only");
  });

  it("makes the project private with an owner's token and no approval id, answering what the platform republished", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PUT ${VISIBILITY}`] = (call) => ({ body: { projectId: "prj_probe", visibility: call.body.visibility, ...PUBLISHED } });

    const out = JSON.parse(await workspace({ action: "set-visibility", visibility: "Private", api: API }));
    const puts = platform.sent("PUT", VISIBILITY);

    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ visibility: "private" });
    expect(puts[0].auth).toBe("Bearer claims.sig");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("visibility-set");
    expect(out.value).toEqual({
      action: "set-visibility",
      project: "acme/widget",
      visibility: "private",
      ...PUBLISHED,
      trackUrl: expect.stringMatching(/\/acme\/widget\/project-settings\/visibility$/),
    });

    expect(out.hint).toContain("workspace members and build links only");
    expect(out.hint).toContain("no approval page was involved");
    expect(out.warnings).toEqual([]);
    expect(platform.calls.some((call) => call.path.startsWith(APPROVALS))).toBe(false);
  });

  it("keeps a public visibility on the approve page: the platform asks, the approval names the visibility alone, and nothing is written", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const scope = { visibility: "public" };
    platform.routes[`PUT ${VISIBILITY}`] = () => approvalRequired(scope);
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: { approvalId: "apr_pub", approvalUrl: `${API}/device/approve/apr_pub`, changes: ["visibility: private -> public"] },
    });

    const out = JSON.parse(await workspace({ action: "set-visibility", visibility: "public", api: API }));
    const [post] = platform.sent("POST", APPROVALS);

    expect(post.body).toMatchObject({ action: VISIBILITY_ACTION, scope, fingerprint: actionFingerprint(VISIBILITY_ACTION, scope) });
    expect(post.body.description).toBe("Make acme/widget public: every build page and channel link opens for anyone.");
    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-required");
    expect(out.value).toMatchObject({ approvalId: "apr_pub", changes: ["visibility: private -> public"] });
    expect(out.error.message).toContain("every build page and channel link it ever made");
    expect(out.error.message).toContain("approvalId apr_pub");
    expect(platform.sent("PUT", VISIBILITY)).toHaveLength(1);
  });

  it("makes the project public once with an approved approval and says what now opens", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${APPROVALS}/apr_pub`] = () => ({
      body: {
        status: "approved",
        used: false,
        fingerprint: actionFingerprint(VISIBILITY_ACTION, { visibility: "public" }),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    platform.routes[`PUT ${VISIBILITY}`] = (call) => ({ body: { projectId: "prj_probe", visibility: call.body.visibility, ...PUBLISHED, exposurePublished: false } });

    const out = JSON.parse(await workspace({ action: "set-visibility", visibility: "public", approvalId: "apr_pub", api: API }));
    const [put] = platform.sent("PUT", VISIBILITY);

    expect(put.body).toEqual({ visibility: "public", approvalId: "apr_pub" });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("visibility-set");
    expect(out.value).toMatchObject({ visibility: "public", exposurePublished: false });
    expect(out.hint).toContain("opens for anyone");
    expect(out.hint).not.toContain("no approval page was involved");
    expect(out.warnings[0]).toContain("did not confirm exposurePublished");
  });

  it("is refused OWNER_REQUIRED when the token's minter is not an owner, before any approval is asked", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PUT ${VISIBILITY}`] = () => ({
      status: 403,
      body: { code: "OWNER_REQUIRED", message: "Changing a project's visibility with a token is a workspace owner action, and this token was minted by an account that is not an owner of this workspace." },
    });

    const out = JSON.parse(await workspace({ action: "set-visibility", visibility: "private", api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.platformCode).toBe("OWNER_REQUIRED");
    expect(platform.calls.some((call) => call.path.startsWith(APPROVALS))).toBe(false);
  });

  it("refuses a missing or unknown visibility before any request", async () => {
    platform.login();

    const missing = JSON.parse(await workspace({ action: "set-visibility", api: API }));
    const unknown = JSON.parse(await workspace({ action: "set-visibility", visibility: "unlisted", api: API }));

    expect(missing.status).toBe("bad-request");
    expect(missing.error.message).toContain("needs visibility: private or public");
    expect(unknown.error.message).toContain('got "unlisted"');
    expect(platform.calls).toHaveLength(0);
  });
});
