import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { safariApprovalReleaseSentence, safariReleaseIntentOf } from "../lib/safari-release-intent";
import { STORE_SETTINGS_ACTION, storeSettingsDigest } from "../lib/store-settings";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const CONFIG = `${PROJECT_ROUTE}/stores/config`;
const LISTING = `${PROJECT_ROUTE}/stores/safari/listing`;
const PUBLISH = `${PROJECT_ROUTE}/stores/safari/publish`;
const PREFLIGHT = `${PROJECT_ROUTE}/stores/safari/submissions/preflight`;
const APPROVALS = "/api/cli/approvals";
const SHA = "abc1234";

const ON_SALE_AT_ONCE = "Apple's approval puts the version on sale at once";
const HELD = "Apple's approval does not put the version on sale";

const STATES: Array<[string, string, string, string]> = [
  ["after approval", "after approval", ON_SALE_AT_ONCE, HELD],
  ["no Release line", "", HELD, ON_SALE_AT_ONCE],
];

function approvalRequired(action: string, scope: Record<string, unknown>) {
  return { status: 403, body: { code: "APPROVAL_REQUIRED", message: "Needs an owner's approval.", approvalRequest: { action, scope, fingerprint: actionFingerprint(action, scope as Record<string, string>) } } };
}

function onSaleSentences(message: string): string[] {
  return message.split(/(?<=\.)\s+/).filter((sentence) => /\bon sale\b/.test(sentence));
}

describe("every Safari review approval says what Apple's approval does from the project's STORE.md release line (ledger 374)", () => {
  const platform = useProjectRoutes("extdev-safari-release-intent-");

  it("reads after approval as on sale at once and anything else as held, naming the line it read", () => {
    expect(safariReleaseIntentOf("after approval")).toEqual({ intent: "after-approval", source: "store-md" });
    expect(safariReleaseIntentOf("After-approval.")).toEqual({ intent: "after-approval", source: "store-md" });
    expect(safariReleaseIntentOf("manual")).toEqual({ intent: "manual", source: "store-md" });
    expect(safariReleaseIntentOf("")).toEqual({ intent: "manual", source: "default" });
    expect(safariApprovalReleaseSentence({ intent: "after-approval", source: "store-md" })).toContain("STORE.md states `- Release: after approval` under `## Safari`");
    expect(safariApprovalReleaseSentence({ intent: "manual", source: "store-md" })).toContain("STORE.md states `- Release: manual` under `## Safari`");
    expect(safariApprovalReleaseSentence({ intent: "manual", source: "default" })).toContain("STORE.md states no `- Release:` line under `## Safari`");
  });

  it("configure-store review says one release sentence, read from the listing STORE.md synced, for both states", async () => {
    if (process.platform === "win32") return;

    const patch = { dryRun: false, publishAfter: true };
    const scope = { store: "safari", settingsDigest: storeSettingsDigest("safari", patch) };

    for (const [name, releaseMode, said, unsaid] of STATES) {
      platform.calls.length = 0;
      platform.login();
      platform.routes[`GET ${LISTING}`] = () => ({ body: { store: "safari", listing: releaseMode ? { title: "Rebeccat", releaseMode } : { title: "Rebeccat" } } });
      platform.routes[`PUT ${CONFIG}`] = () => approvalRequired(STORE_SETTINGS_ACTION, scope);
      platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_rv", approvalUrl: `${API}/device/approve/apr_rv`, changes: ['safari.submissionMode: "draft" -> "review"'] } });

      const out = JSON.parse(await submit({ action: "configure-store", store: "safari", storeSettings: { submissionMode: "review" }, api: API }));

      expect(out.status, name).toBe("approval-required");
      expect(out.error.message, name).toContain(said);
      expect(out.error.message, name).not.toContain(unsaid);
      expect(onSaleSentences(out.error.message), name).toHaveLength(1);
      expect(platform.sent("GET", LISTING), name).toHaveLength(1);
    }
  });

  it("configure-store keeps the platform's release sentence as the only one when the approval it minted says it", async () => {
    if (process.platform === "win32") return;

    const patch = { dryRun: false, publishAfter: true };
    const scope = { store: "safari", settingsDigest: storeSettingsDigest("safari", patch) };
    const platformSentence = "Apple's approval puts the version on sale at once: STORE.md states `- Release: after approval` under `## Safari`, so the review act sets it to release automatically after approval.";

    platform.login();
    platform.routes[`GET ${LISTING}`] = () => ({ body: { store: "safari", listing: {} } });
    platform.routes[`PUT ${CONFIG}`] = () => approvalRequired(STORE_SETTINGS_ACTION, scope);
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: { approvalId: "apr_rv", approvalUrl: `${API}/device/approve/apr_rv`, description: `Change the App Store store settings of rebeccat: safari.submissionMode: "draft" -> "review". ${platformSentence}` },
    });

    const out = JSON.parse(await submit({ action: "configure-store", store: "safari", storeSettings: { submissionMode: "review" }, api: API }));

    expect(out.value.description).toContain(platformSentence);
    expect(out.error.message).not.toContain(HELD);
    expect(onSaleSentences(out.error.message)).toEqual([platformSentence]);
  });

  it("publish to App Review says the same release sentence in the reason and the say, for both states", async () => {
    if (process.platform === "win32") return;

    const scope = { store: "safari", submissionId: "sub_s" };

    for (const [name, releaseMode, said, unsaid] of STATES) {
      platform.calls.length = 0;
      platform.login();
      platform.routes[`GET ${LISTING}`] = () => ({ body: { store: "safari", listing: { releaseMode } } });
      platform.routes[`POST ${PUBLISH}`] = () => approvalRequired("extension_store.publish", scope);
      platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_pb", approvalUrl: `${API}/device/approve/apr_pb` } });

      const out = JSON.parse(await submit({ action: "publish", browsers: ["safari"], api: API }));

      expect(out.status, name).toBe("approval-required");
      expect(out.error.message, name).toContain(said);
      expect(out.error.message, name).not.toContain(unsaid);
      expect(out.value.sayToPerson, name).toContain(said);
      expect(out.value.sayToPerson, name).not.toContain(unsaid);
    }
  });

  it("submit under the saved review mode names the release in its version approval and in the line it leaves, for both states", async () => {
    if (process.platform === "win32") return;

    for (const [name, releaseMode, said, unsaid] of STATES) {
      platform.calls.length = 0;
      platform.login();
      platform.routes[`GET ${LISTING}`] = () => ({ body: { store: "safari", listing: { releaseMode } } });
      platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: { submissionMode: { id: "review", label: "Send to App Review", description: "One approval reaches review." } } });
      platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_sv", approvalUrl: `${API}/device/approve/apr_sv` } });

      await submit({ browsers: ["safari"], buildSha: SHA, dryRun: false, version: "0.3.0", api: API });
      const sent = platform.sent("POST", APPROVALS)[0];

      expect(sent.body.description, name).toContain(said);
      expect(sent.body.description, name).not.toContain(unsaid);
      expect(sent.body.description, name).not.toContain("stays its own");
    }
  });
});
