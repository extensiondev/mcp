import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { safariApprovalReleaseSentence, safariReleaseIntentOf } from "../lib/safari-release-intent";
import { STORE_SETTINGS_ACTION, storeSettingsDigest } from "../lib/store-settings";
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
});
