import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { TOOL_POLICY } from "../lib/tool-policy";
import { handler as status } from "../tools/release-status";
import { handler as submit, schema } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const SUBMISSION = "sub_7f3a";
const CANCEL = `${PROJECT_ROUTE}/stores/chrome/submissions/${SUBMISSION}/cancel`;
const ROLLOUT = `${PROJECT_ROUTE}/stores/chrome/rollout`;
const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const APPROVALS = "/api/cli/approvals";

function approvalRequired(action: string, scope: Record<string, string>) {
  return {
    status: 403,
    body: { code: "APPROVAL_REQUIRED", message: "Needs an owner's approval.", approvalRequest: { action, scope, fingerprint: actionFingerprint(action, scope) } },
  };
}

function report(store: string, canSubmit: boolean) {
  return {
    store,
    summary: { pass: 9, warn: 1, fail: canSubmit ? 0 : 1, blockingFailures: canSubmit ? 0 : 1, canSubmit },
    checks: [
      { id: "credentials", label: "Store credentials", status: canSubmit ? "pass" : "fail", severity: "blocking", stage: "integration", ownership: "user", message: canSubmit ? "" : "CHROME_CLIENT_SECRET is missing." },
      { id: "privacy", label: "Privacy policy URL", status: "warn", severity: "advisory", stage: "review", ownership: "user", message: "No privacy policy URL." },
      { id: "manifest", label: "Manifest", status: "pass", severity: "blocking", stage: "integration", ownership: "platform" },
    ],
    prefill: { fields: [{ key: "description", label: "Description", value: "A long user-written text" }] },
  };
}

describe("extension_submit withdraws a submission, raises a staged rollout and checks readiness", () => {
  const platform = useProjectRoutes("extdev-store-acts-");

  it("offers the store acts beside submit, and only the ones that change what users get count as shipping", () => {
    expect(schema.inputSchema.properties.action.enum).toEqual(["submit", "preflight", "cancel", "rollout"]);
    expect(schema.inputSchema.required).toEqual([]);

    const ships = TOOL_POLICY.extension_submit.ships as (args: Record<string, unknown>) => boolean;

    expect(ships({ action: "cancel" })).toBe(true);
    expect(ships({ action: "rollout" })).toBe(true);
    expect(ships({ action: "preflight" })).toBe(false);
    expect(ships({ action: "submit", dryRun: false })).toBe(true);
    expect(ships({ browsers: ["chrome"], buildSha: "abc" })).toBe(false);
  });

  it("cancel needs a submission id and asks nothing without one", async () => {
    const out = JSON.parse(await submit({ action: "cancel", api: API }));

    expect(out.status).toBe("bad-request");
    expect(platform.calls).toHaveLength(0);
  });

  it("cancel of a submission the store is not reviewing says how to find one that is", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${CANCEL}`] = () => ({
      status: 409,
      body: { code: "SUBMISSION_NOT_IN_REVIEW", message: "This submission is not in review.", refusedBeforeApproval: true },
    });

    const out = JSON.parse(await submit({ action: "cancel", submissionId: SUBMISSION, api: API }));

    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.status).toBe("cancel-refused");
    expect(out.error.platformCode).toBe("SUBMISSION_NOT_IN_REVIEW");
    expect(out.hint).toContain("extension_release_status");
  });

  it("cancel asks for an approval of withdrawing exactly this submission", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const scope = { store: "chrome", submissionId: SUBMISSION };
    platform.routes[`POST ${CANCEL}`] = () => approvalRequired("extension_store.cancel", scope);
    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_c", approvalUrl: `${API}/approve/apr_c`, description: "Withdraw Chrome Web Store submission sub_7f3a from review." } });

    const out = JSON.parse(await submit({ action: "cancel", submissionId: SUBMISSION, api: API }));

    expect(platform.sent("POST", APPROVALS)[0].body.scope).toEqual(scope);
    expect(out.status).toBe("approval-required");
    expect(out.value.approvalUrl).toBe(`${API}/approve/apr_c`);
  });

  it("cancel approved answers with the dispatch and says where to read the outcome", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${CANCEL}`] = () => ({ body: { ok: true, dispatched: true, store: "chrome", submissionId: SUBMISSION, storeSubmissionId: "cws_1", dispatchId: "d-1" } });

    const out = JSON.parse(await submit({ action: "cancel", submissionId: SUBMISSION, approvalId: "apr_c", api: API }));

    expect(platform.sent("POST", CANCEL)[0].body).toEqual({ approvalId: "apr_c" });
    expect(out.status).toBe("cancel-dispatched");
    expect(out.value.dispatchId).toBe("d-1");
    expect(out.hint).toContain("extension_release_status");
  });

  it("rollout takes a whole percentage from 1 to 100 and refuses anything else before asking", async () => {
    for (const deployPercentage of [0, 101, 12.5, undefined]) {
      const out = JSON.parse(await submit({ action: "rollout", deployPercentage, api: API }));

      expect(out.status).toBe("bad-request");
    }

    expect(platform.calls).toHaveLength(0);
  });

  it("rollout of a project that does not stage its Chrome release says where staging is turned on", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${ROLLOUT}`] = () => ({
      status: 409,
      body: { code: "ROLLOUT_NOT_STAGED", message: "This project does not publish Chrome as a staged rollout.", refusedBeforeApproval: true },
    });

    const out = JSON.parse(await submit({ action: "rollout", deployPercentage: 50, api: API }));

    expect(platform.sent("POST", ROLLOUT)[0].body).toEqual({ deployPercentage: 50 });
    expect(out.status).toBe("rollout-refused");
    expect(out.hint).toContain("Staged publish");
  });

  it("rollout asks for an approval and says Chrome will not take it back down", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const scope = { store: "chrome", deployPercentage: "50" };
    platform.routes[`POST ${ROLLOUT}`] = () => approvalRequired("extension_store.rollout", scope);
    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_r", approvalUrl: `${API}/approve/apr_r` } });

    const out = JSON.parse(await submit({ action: "rollout", deployPercentage: 50, api: API }));

    expect(platform.sent("POST", APPROVALS)[0].body.scope).toEqual(scope);
    expect(out.status).toBe("approval-required");
    expect(out.error.message).toContain("irreversible");
  });

  it("preflight reads each store's readiness, asks for no approval and writes nothing", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: report("chrome", false) });
    platform.routes[`POST ${PREFLIGHT("firefox")}`] = () => ({ body: report("firefox", true) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome", "firefox"], buildSha: "603fc8a", channel: "stable", api: API }));

    expect(platform.sent("POST", PREFLIGHT("chrome"))[0].body).toEqual({ buildId: "603fc8a", channel: "stable" });
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.ok).toBe(true);
    expect(out.status).toBe("preflight-read");
    expect(out.value.stores.chrome).toMatchObject({ canSubmit: false, failing: [{ id: "credentials", message: "CHROME_CLIENT_SECRET is missing." }] });
    expect(out.value.stores.chrome.warnings).toEqual([{ id: "privacy", label: "Privacy policy URL", severity: "advisory", message: "No privacy policy URL." }]);
    expect(out.value.stores.firefox.canSubmit).toBe(true);
    expect(JSON.stringify(out)).not.toContain("A long user-written text");
    expect(out.hint).toContain("chrome");
  });

  it("the stores read keeps the platform's id of the latest submission, which cancel takes", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: SUBMISSION, store: "chrome", status: "submitted", buildId: "603fc8a", channel: "stable", submittedAt: "2026-10-11T18:37:59.602Z" }] },
    });

    const out = JSON.parse(await status({ include: ["stores"], api: API }));
    const chrome = out.value.stores.value.stores.find((row: { store: string }) => row.store === "chrome");

    expect(chrome.lastSubmission).toMatchObject({ id: SUBMISSION, status: "submitted" });
  });

  it("a real submit still needs browsers and a build", async () => {
    platform.login();
    const out = JSON.parse(await submit({ api: API }));

    expect(out.status).toBe("bad-request");
  });
});
