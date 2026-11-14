// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { afterEach, describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { handler as submit } from "../tools/submit-local";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const ID = `apr_${"K".repeat(32)}`;
const SHA = "6b393ca";
const SCOPE = { acts: ["safari:publish", "safari:upload"], buildSha: SHA, version: "0.3.0" };
const PREFLIGHT = `POST ${PROJECT_ROUTE}/stores/safari/submissions/preflight`;

const draftRecord = () => ({
  body: { submissions: [{ id: "sub_s", store: "safari", status: "draft", storeVersion: { packaged: "0.3.0", displayed: "0.3.0", buildNumber: 18 } }] },
});

describe("a Safari submit that lands on TestFlight names the publish as the next step, never done (ledger 379)", () => {
  const platform = useProjectRoutes("extdev-safari-testflight-step-");

  afterEach(() => {
    delete process.env.EXTENSION_DEV_APPROVAL_GATE;
  });

  it("names the publish call and the one more approval it asks when no publish line rode on the submit", async () => {
    if (process.platform === "win32") return;

    platform.login();
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.routes["POST /api/cli/stores/submit"] = () => ({ body: { ok: true, submissions: [{ id: "sub_s", store: "safari", status: "pending" }] } });
    platform.routes["GET /api/cli/stores/submissions"] = draftRecord;

    const out = JSON.parse(await submit({ browsers: ["safari"], buildSha: SHA, dryRun: false, waitSeconds: 5, api: API }));

    expect(out.status).toBe("submitted");
    expect(out.value.nextStep.kind).toBe("publish");
    expect(out.value.nextStep.say).toContain('call extension_submit action "publish" with browsers ["safari"], which asks one more owner approval');
    expect(out.value.sayToPerson).toBe(out.value.nextStep.say);
  });

  it("names the approval whose publish line still stands when the saved review mode put it on the submit", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[PREFLIGHT] = () => ({
      body: { submissionMode: { id: "review", label: "Send to App Review", description: "One approval reaches review." } },
    });

    platform.routes[`GET /api/cli/approvals/${ID}`] = () => ({
      body: {
        status: "approved",
        fingerprint: actionFingerprint("extension_submit.version", SCOPE),
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        used: false,
        approver: "octocat",
        lines: [
          { id: "safari:upload", store: "safari", act: "upload", state: "pending" },
          { id: "safari:publish", store: "safari", act: "publish", state: "pending" },
        ],
      },
    });

    platform.routes["POST /api/cli/stores/submit"] = () => ({
      body: {
        ok: true,
        submissions: [{ id: "sub_s", store: "safari", status: "pending" }],
        approvalId: ID,
        lines: [
          { id: "safari:upload", store: "safari", act: "upload", state: "spent" },
          { id: "safari:publish", store: "safari", act: "publish", state: "pending" },
        ],
      },
    });

    platform.routes["GET /api/cli/stores/submissions"] = draftRecord;

    const out = JSON.parse(await submit({ browsers: ["safari"], buildSha: SHA, version: "0.3.0", dryRun: false, approvalId: ID, waitSeconds: 5, api: API }));

    expect(out.status).toBe("submitted");
    expect(out.value.approvalCovers.approvalId).toBe(ID);
    expect(out.value.nextStep.kind).toBe("publish");
    expect(out.value.nextStep.say).toContain(`and approvalId ${ID}, which spends the publish line of that approval and asks no second one`);
  });
});

describe("a publish Apple refused ends its sentence once (ledger 380)", () => {
  const platform = useProjectRoutes("extdev-safari-publish-period-");

  it("keeps Apple's words, the associated errors among them, and one closing period", async () => {
    if (process.platform === "win32") return;

    const words =
      "App Store Connect refused to add version 0.3.0 to review submission rs_1: STATE_ERROR.ENTITY_STATE_INVALID: appStoreVersions with id 'v1' is not in valid state.: This resource cannot be reviewed, please check associated errors to see why. Associated errors: copyright: ENTITY_ERROR.ATTRIBUTE.REQUIRED: You must provide a value for the attribute 'copyright' with this request.";

    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/stores/safari/publish`] = () => ({
      body: { ok: true, dispatched: true, store: "safari", submissionId: "sub_s", dispatchedAt: "2026-11-02T14:47:11.581Z" },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: {
        submissions: [
          {
            id: "sub_s",
            store: "safari",
            status: "draft",
            storeReview: { state: "FAILED", checkedAt: "2026-11-02T14:48:30.000Z", source: "publish-answer" },
            publish: { act: "publish", status: "failed", storeMessage: words, at: "2026-11-02T14:48:31.000Z" },
          },
        ],
      },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["safari"], approvalId: "apr_p", waitSeconds: 5, api: API }));

    expect(out.status).toBe("publish-failed");
    expect(out.error.message).toContain("Associated errors: copyright: ENTITY_ERROR.ATTRIBUTE.REQUIRED");
    expect(out.error.message).toMatch(/with this request\.$/);
    expect(out.error.message).not.toMatch(/\.\.$/);
  });
});
