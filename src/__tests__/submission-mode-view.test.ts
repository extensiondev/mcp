import { describe, expect, it } from "vitest";

import { SAFARI_RELEASE_LINE_SENTENCE } from "../lib/store-settings";
import { SAFARI_DRAFT_FROM_HERE, SAFARI_REVIEW_FROM_HERE, submissionModeView } from "../lib/submission-mode-view";
import { handler as submit, schema } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;

function report(store: string, submissionMode: Record<string, unknown>) {
  return {
    store,
    summary: { pass: 3, warn: 0, fail: 0, blockingFailures: 0, canSubmit: true },
    submissionMode,
    checks: [{ id: "manifest", label: "Manifest", status: "pass", severity: "blocking", stage: "integration", ownership: "platform" }],
  };
}

const SAFARI_DRAFT = { id: "draft", label: "TestFlight draft", description: "Safari builds upload to App Store Connect and stay as a TestFlight/draft build.", rollout: "safe" };
const CHROME_PUBLIC_SET = {
  id: "public",
  label: "Public publish",
  description: "Chrome submissions will use the default publish target and can go public after approval.",
  rollout: "broad",
  setBy: { mode: "public", by: "owner", at: "2026-11-01T11:02:00.000Z", via: "approval", approvalId: "apr_iA1Z" },
};

describe("the preflight names every way a store can go public, and who chose the saved one (ledgers 362, 364)", () => {
  const platform = useProjectRoutes("extdev-mode-view-");

  it("names the Safari review mode, how to save it, and the STORE.md release line under the draft mode", () => {
    const view = submissionModeView("safari", SAFARI_DRAFT);

    expect(view?.fromHere).toBe(SAFARI_DRAFT_FROM_HERE);
    expect(view?.fromHere).toContain('storeSettings: {submissionMode: "review"}');
    expect(view?.release).toBe(SAFARI_RELEASE_LINE_SENTENCE);
    expect(view?.release).toContain("`- Release: after approval` lets Apple's approval put it on sale at once");
    expect(view?.modes).toEqual(["draft", "review", "dry-run"]);
  });

  it("says a saved Safari review mode sends the build on to App Review under the submit's approval", () => {
    expect(submissionModeView("safari", { ...SAFARI_DRAFT, id: "review", label: "Send to App Review" })?.fromHere).toBe(SAFARI_REVIEW_FROM_HERE);
  });

  it("relays who set a go-public mode and when, and drops a stamp that is not the owner's", () => {
    const view = submissionModeView("chrome", CHROME_PUBLIC_SET);

    expect(view?.setBy).toEqual({ by: "owner", at: "2026-11-01T11:02:00.000Z", via: "approval", approvalId: "apr_iA1Z" });
    expect(view?.setBySay).toBe("The workspace owner set this mode on 2026-11-01 under approval apr_iA1Z, so it is intended.");
    expect(submissionModeView("chrome", { ...CHROME_PUBLIC_SET, setBy: { by: "member", at: "2026-11-01" } })?.setBy).toBeUndefined();
  });

  it("the tool description lists Safari review among the go-public modes and never says Safari always stops at the draft", () => {
    const described = JSON.stringify(schema.inputSchema);

    expect(described).toContain("(chrome public or staged, edge review, firefox listed, safari review; chrome draft-until-public");
    expect(described).toContain("stops at the TestFlight draft unless the saved safari mode is review");
    expect(described).not.toContain("stops at the TestFlight draft;");
  });

  it("preflight answers both Safari options in the store view and the hint", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({ body: report("safari", SAFARI_DRAFT) });

    const pre = JSON.parse(await submit({ action: "preflight", browsers: ["safari"], buildSha: "6b393ca", api: API }));

    expect(pre.value.stores.safari.submissionMode.fromHere).toBe(SAFARI_DRAFT_FROM_HERE);
    expect(pre.value.stores.safari.submissionMode.release).toBe(SAFARI_RELEASE_LINE_SENTENCE);
    expect(pre.hint).toContain('submissionMode: "review"');
    expect(pre.hint).toContain("`- Release: after approval`");
  });

  it("preflight names the owner who set Chrome public instead of leaving it unexplained", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: report("chrome", CHROME_PUBLIC_SET) });

    const pre = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], buildSha: "6b393ca", api: API }));

    expect(pre.value.stores.chrome.submissionMode.setBy.approvalId).toBe("apr_iA1Z");
    expect(pre.hint).toContain("The workspace owner set this mode on 2026-11-01 under approval apr_iA1Z, so it is intended.");
  });
});
