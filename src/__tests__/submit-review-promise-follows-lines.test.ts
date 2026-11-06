// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { reviewPromiseOf } from "../lib/review-promise";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const ID = `apr_${"R".repeat(32)}`;
const SHA = "6b393ca";
const FIREFOX_LISTED =
  "Under Firefox AMO's saved channel \"listed\" this upload goes to Mozilla's review after it lands and is listed publicly when it passes; to upload unlisted instead, set the channel to unlisted in the console store settings before approving.";

const line = (store: string, act: string, sentence: string) => ({ id: `${store}:${act}`, store, act, state: "pending", line: sentence });

const REBECCAT_LINES = [
  line("chrome", "upload", "Publish sends the draft to Chrome's review; Chrome is reviewing nothing else for this item."),
  line("edge", "upload", "Publish sends the draft Partner Center holds for Rebeccat to certification review; nothing is in review now, and what the store serves stays until Microsoft certifies the draft."),
  line("firefox", "upload", `Upload sends build ${SHA} as version 0.3.0.9 to AMO's listed channel for review; nothing of this add-on is awaiting review, and what AMO serves stays until Mozilla approves the new version.`),
  line("safari", "upload", `Upload build ${SHA} to App Store Connect as a TestFlight build.`),
];

describe("the submit approval's review sentence follows the per-store lines it sits over (ledger 359)", () => {
  const platform = useProjectRoutes("extdev-review-promise-");

  it("names the three stores the lines send to review and Safari's TestFlight draft, never Nothing goes to review", async () => {
    platform.login();
    platform.routes["POST /api/cli/approvals"] = () => ({
      status: 201,
      body: {
        approvalId: ID,
        approvalUrl: `${API}/device/approve/${ID}`,
        expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
        description: `Send build ${SHA} to the stores.`,
        lines: REBECCAT_LINES,
      },
    });

    const out = JSON.parse(await submit({ browsers: ["chrome", "edge", "firefox", "safari"], buildSha: SHA, dryRun: false, api: API }));
    const expected = "Chrome, Edge and Firefox go to review on approval; Safari stays a TestFlight draft.";

    expect(out.status).toBe("approval-required");
    expect(out.value.reviewPromise).toBe(`${expected} ${FIREFOX_LISTED}`);
    expect(out.value.nextStep.say).toContain(expected);
    expect(out.hint).toContain(expected);
    expect(JSON.stringify(out)).not.toContain("Nothing goes to review");
    expect(platform.sent("POST", "/api/cli/stores/submit")).toHaveLength(0);
  });

  it("keeps the draft promise when every line stops at a draft or signs without review", async () => {
    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/stores/firefox/submissions/preflight`] = () => ({ body: { submissionMode: { id: "unlisted", label: "Unlisted" } } });
    platform.routes["POST /api/cli/approvals"] = () => ({
      status: 201,
      body: {
        approvalId: ID,
        approvalUrl: `${API}/device/approve/${ID}`,
        lines: [
          line("chrome", "upload", `Upload build ${SHA} to the Chrome Web Store as a draft.`),
          line("firefox", "upload", `Upload sends build ${SHA} as version 0.3.0.9 to AMO's unlisted channel, where Mozilla signs it for self distribution without a review; nothing of this add-on is awaiting review.`),
        ],
      },
    });

    const out = JSON.parse(await submit({ browsers: ["chrome", "firefox"], buildSha: SHA, dryRun: false, api: API }));

    expect(out.value.reviewPromise).toBe("Nothing goes to review until you publish.");
  });

  it("reads a store's saved mode when its line carries no sentence", () => {
    expect(reviewPromiseOf(["firefox", "edge"], [], { firefox: "listed", edge: "draft" })).toBe(`Firefox goes to review on approval; Edge stays a draft. ${FIREFOX_LISTED}`);
    expect(reviewPromiseOf(["safari"], [{ store: "safari", act: "upload", line: "" }, { store: "safari", act: "publish", line: "" }])).toBe("Safari goes to review on approval.");
    expect(reviewPromiseOf(["firefox"], [], { firefox: "unlisted" })).toBe("");
  });
});
