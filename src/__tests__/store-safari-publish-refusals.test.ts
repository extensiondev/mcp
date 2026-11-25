import { describe, expect, it } from "vitest";

import { shipRefusalHint } from "../lib/ship-act";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const SAFARI_PUBLISH = `${PROJECT_ROUTE}/stores/safari/publish`;
const APPROVALS = "/api/cli/approvals";

describe("the draft refusal hints name the store of the call", () => {
  it("says a Safari draft, an Edge draft and a Chrome draft, never Chrome for every store", () => {
    expect(shipRefusalHint("SUBMISSION_NOT_DRAFT", undefined, "safari")).toMatch(/^Only a Safari draft can be sent to review\./);
    expect(shipRefusalHint("SUBMISSION_NOT_DRAFT", undefined, "edge")).toMatch(/^Only an Edge draft can be sent to review\./);
    expect(shipRefusalHint("SUBMISSION_NOT_DRAFT", undefined, "chrome")).toMatch(/^Only a Chrome draft can be sent to review\./);
    expect(shipRefusalHint("SUBMISSION_NOT_DRAFT")).toMatch(/^Only a Chrome draft/);
    expect(shipRefusalHint("NO_CHROME_DRAFT", undefined, "safari")).toContain('There is no Safari draft to send yet. Submit a build with extension_submit (browsers: ["safari"]');
  });
});

describe("extension_submit publish for Safari with the TestFlight build named", () => {
  const platform = useProjectRoutes("extdev-safari-publish-build-number-");

  it("names the withdrawal that clears a version Apple holds in review", () => {
    expect(shipRefusalHint("SAFARI_VERSION_IN_REVIEW", undefined, "safari")).toContain('extension_approvals_request {act: "extension_submit", args: {action: "cancel", store: "safari", submissionId: value.heldSubmissionId}}');
  });
});
