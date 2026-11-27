import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { VERSION_ACTION, versionScopeFor } from "../lib/approval-lines";
import { openShipApi, runShipAct, shipRefusalHint } from "../lib/ship-act";
import { TOOL_POLICY } from "../lib/tool-policy";
import { handler as status } from "../tools/release-status";
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
    submissionMode: store === "chrome" ? { id: "draft-until-public", label: "Draft until published", description: "New versions upload as a draft and are not published, until the Chrome Web Store reports this item as published.", rollout: "safe" } : undefined,
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

  const offLane = (store: string, act: string, subject: string, handPath?: string, handUrl?: string) => ({
    status: 409,
    body: {
      code: "STORE_ACT_NOT_ON_LANE",
      store,
      act,
      refusedBeforeApproval: true,
      message: `${subject} does not run on the extension.dev lane yet, so nothing was sent to the store and no approval was asked for or spent. ${handPath ? `To do it now, ${handPath}.` : `Leave ${store} out of this call until the lane runs it.`}`,
      ...(handPath ? { handPath } : {}),
      ...(handUrl ? { handUrl } : {}),
    },
  });

  const expectByHand = (out: any, handPath: string, handUrl?: string) => {
    expect(out.ok).toBe(false);
    expect(out.error.platformCode).toBe("STORE_ACT_NOT_ON_LANE");
    expect(out.value).toMatchObject({ owner: "store", refusedBeforeApproval: true, handPath });
    expect(out.value.nextStep).toEqual({ kind: "dashboard", say: out.value.sayToPerson, url: handUrl ?? null });
    expect(out.value.sayToPerson).toContain(`To do it now, ${handPath}.`);
    expect(out.hint).toBe(out.value.sayToPerson);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  };

  it("1305: an approval ask the platform answers with an older build's approval names that approval, its build and the latest one, and says it will not be spent", async () => {
    platform.login();
    const scope = { store: "edge", firstSubmission: "partner-center", buildSha: "c1d7afe", packageSha256: "e".repeat(64), visibility: "hidden" };
    const earlier = { approvalId: "apr_old", status: "approved", buildSha: "9de7bae", latestBuildSha: "c1d7afe", approvalUrl: `${API}/device/approve/apr_old` };
    const asked = approvalRequired("extension_store.publish", scope);

    platform.routes[`POST ${PROJECT_ROUTE}/stores/edge/first-submission`] = () => ({ ...asked, body: { ...asked.body, supersededApproval: earlier } });
    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_new", approvalUrl: `${API}/device/approve/apr_new`, description: "First Edge submission." } });

    const opened = await openShipApi("extension_submit", { api: API }, { action: "first-submission", store: "edge" });
    if ("refused" in opened) throw new Error(opened.refused);

    const act = { command: "extension_submit", act: "first-submission", action: "extension_store.publish", route: "stores/edge/first-submission", body: {}, description: "First Edge submission.", reason: "Partner Center only.", stateRead: "the first-submission read", scopeFits: () => true, value: { store: "edge" } };
    const ran = await runShipAct(act, opened.api);
    const out = JSON.parse(ran.ok ? "{}" : ran.out);

    expect(out).toMatchObject({ ok: false, status: "approval-required", value: { approvalId: "apr_new", supersededApproval: earlier } });
    expect(out.hint.startsWith(`Approval apr_old is approved but unspent, yet it names build 9de7bae; the latest build is c1d7afe, so apr_old will not be spent. The owner approves the new one at ${API}/device/approve/apr_new instead.`)).toBe(true);

    platform.routes[`POST ${PROJECT_ROUTE}/stores/edge/first-submission`] = () => asked;
    const plain = await runShipAct(act, opened.api);

    expect(JSON.parse(plain.ok ? "{}" : plain.out).value).not.toHaveProperty("supersededApproval");
  });

  it("610: a Firefox publish off the lane says Firefox has no publish act and AMO reviews a version when it is submitted", () => {
    const firefox = offLane("firefox", "publish", "Sending the Firefox Add-ons draft to review").body;
    const chrome = offLane("chrome", "publish", "Sending the Chrome Web Store draft to review").body;

    expect(shipRefusalHint("STORE_ACT_NOT_ON_LANE", undefined, "", firefox)).toContain("Firefox has no publish act; Mozilla reviews a Firefox version when it is submitted.");
    expect(shipRefusalHint("STORE_ACT_NOT_ON_LANE", undefined, "", chrome)).toBeUndefined();
    expect(shipRefusalHint("PUBLISH_STORE_NOT_SUPPORTED")).toBeUndefined();
    expect(shipRefusalHint("CANCEL_STORE_NOT_SUPPORTED")).toBeUndefined();

    for (const code of ["CANCEL_WORKFLOW_UNSUPPORTED", "ROLLOUT_WORKFLOW_UNSUPPORTED", "PUBLISH_WORKFLOW_UNSUPPORTED", "RELEASE_WORKFLOW_UNSUPPORTED"]) {
      expect(shipRefusalHint(code)).toBeUndefined();
    }
  });

  it("610, 683: a project with no lane key is named in lane words, and the retired NO_MIRROR has no hint", () => {
    const laneKey = shipRefusalHint("NO_LANE_KEY") ?? "";

    expect(laneKey).toContain("nothing was sent to the store");
    expect(laneKey).toContain("Open the project in the console to confirm it still exists");
    expect(laneKey).not.toMatch(/first build|\bmirror\b/i);
    expect(shipRefusalHint("NO_MIRROR")).toBeUndefined();
  });

  it("681: a NO_LANE_KEY refusal before any approval names the act of the call and no approval, and only the queue replay keeps the queued wording", () => {
    const before = { refusedBeforeApproval: true };
    const publish = shipRefusalHint("NO_LANE_KEY", undefined, "chrome", before, "publish") ?? "";

    expect(publish).toBe("This project has no lane key, so the platform had nowhere to run the publish: nothing was sent to the store and no approval was asked for. Open the project in the console to confirm it still exists, then call publish again.");

    for (const act of ["release", "rollout", "cancel"]) {
      const hint = shipRefusalHint("NO_LANE_KEY", undefined, "chrome", before, act) ?? "";

      expect(hint).toContain(`nowhere to run the ${act}`);
      expect(hint).toContain(`then call ${act} again.`);
      expect(hint).not.toMatch(/queued upload|approval went back|submit the build again/);
    }

    expect(shipRefusalHint("NO_LANE_KEY", undefined, "chrome", { ...before, act: "cancel" })).toContain("then call cancel again.");
    expect(shipRefusalHint("NO_LANE_KEY", undefined, "chrome", before)).toContain("then make the same call again.");

    const queued = shipRefusalHint("NO_LANE_KEY", undefined, "chrome", {}, "publish") ?? "";

    expect(queued).toContain("the queued upload had nowhere to run");
    expect(queued).toContain("the approval went back");
  });
});
