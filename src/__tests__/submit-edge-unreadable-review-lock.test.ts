// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { handler as submit, schema } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PRODUCT = "903d21e4-0e5b-4507-95f2-4620fcf06f1c";
const PRODUCT_URL = `https://partner.microsoft.com/dashboard/microsoftedge/${PRODUCT}/packages/dashboard`;
const PREFLIGHT = `POST ${PROJECT_ROUTE}/stores/edge/submissions/preflight`;
const IN_PROGRESS_WORD =
  "InProgressSubmission: Can't publish extension as your extension submission is in progress. Please try again later.";
const REASON = `could not be read: Partner Center does not expose a hand submission's state; check Partner Center at ${PRODUCT_URL}`;
const LOCK = {
  kind: "review-in-progress",
  source: "unreadable",
  clearsWhen: "Edge Add-ons lists the product (the store serves it, so the owner's Partner Center submission of 2026-10-31 is certified) or the 7 business days of certification pass; its state " + REASON + ".",
  storeWord: IN_PROGRESS_WORD,
  readAt: "2026-10-31T13:00:00.000Z",
  reason: REASON,
};
const APPROVAL = `Upload replaces the draft package of Partner Center product ${PRODUCT} with this build (0.1.0.1) once Edge Add-ons lists the product; the owner's Partner Center submission of 2026-10-31 is in certification review and its state ${REASON}. The draft is not sent to review.`;

function report() {
  return {
    store: "edge",
    summary: { pass: 9, warn: 0, fail: 0, blockingFailures: 0, canSubmit: true },
    checks: [{ id: "manifest", label: "Manifest", status: "pass", severity: "blocking" }],
    connection: { kind: "apiKey", connectedAs: PRODUCT, healthy: true, itemId: PRODUCT, itemLinked: true },
    storeConfig: { storeId: PRODUCT, submissionMode: { id: "draft", label: "Draft only", description: "" } },
    submissionMode: { id: "draft", label: "Draft only", description: "" },
    edgeFirstSubmission: { state: "have", productId: PRODUCT, partnerCenterUrl: PRODUCT_URL, blocksSubmit: false, steps: [], source: "owner", at: "2026-10-31T13:00:00.000Z" },
    edgePreflight: {
      act: "upload",
      checks: [
        {
          id: "edge.review_in_progress",
          severity: "blocking",
          status: "locked",
          label: "A submission is in certification review",
          message: `The owner's Partner Center submission of 2026-10-31 is in certification review until Edge Add-ons lists the product, and its state ${REASON}.`,
          docs: "https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api",
          lock: LOCK,
          dashboardUrl: PRODUCT_URL,
        },
      ],
      blocking: [],
      warnings: [],
      lock: LOCK,
      inFlight: null,
      approval: APPROVAL,
      nextVersion: "0.1.0.1",
    },
  };
}

describe("extension_submit preflight relays the Edge review the platform could not read (ledger 329)", () => {
  const platform = useProjectRoutes("extdev-edge-unreadable-");

  it("carries the lock's source and reason, says the state in the hint, and never calls the product idle", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[PREFLIGHT] = () => ({ body: report() });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["edge"], api: API }));
    const edge = out.value.storePreflight.edge;

    expect(edge.lock).toEqual(LOCK);
    expect(edge.approval).toBe(APPROVAL);
    expect(out.value.stores.edge.failing).toEqual([]);
    expect(out.value.stores.edge.canSubmit).toBe(true);
    expect(out.hint).toContain(`edge: a submission is in certification review and its state ${REASON}; the upload is queued until Edge Add-ons lists the product`);
    expect(out.hint).toContain("never failed, and nothing here can call the product idle");
    expect(JSON.stringify(out)).not.toContain("nothing is in certification review");
    expect(JSON.stringify(out)).not.toContain("nothing is in review");
  });

  it("tells the agent in the tool description what an unreadable lock source means", () => {
    const action = String((schema.inputSchema.properties as Record<string, { description?: string }>).action.description);

    expect(action).toContain("lock.source is store for a review the platform sent");
    expect(action).toContain("unreadable for the owner's own Partner Center submission");
    expect(action).toContain("lock.reason says so and names the Partner Center page");
  });
});
