import { describe, expect, it } from "vitest";

import { LISTING_INCOMPLETE_CODE, listingIncompleteOf, listingIncompleteSentence } from "../lib/store-listing-incomplete";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PUBLISH = `${PROJECT_ROUTE}/stores/chrome/publish`;
const SUBMIT = "/api/cli/stores/submit";

const MISSING = [
  {
    id: "chrome.screenshots",
    label: "Screenshots",
    required: true,
    format: "1 to 5 images, 1280x800 or 640x400 px, JPEG or 24-bit PNG with no alpha.",
    satisfiedBy: "store-dashboard",
    how: "Upload them on the Store listing tab.",
    docs: "https://developer.chrome.com/docs/webstore/images",
    status: "missing",
    actual: "0 screenshots",
  },
  {
    id: "chrome.single_purpose",
    label: "Single purpose description",
    required: true,
    format: "One sentence.",
    satisfiedBy: "store-md: Single purpose",
    how: "Write `### Single purpose` under `## Chrome Web Store` in STORE.md.",
    status: "missing",
  },
];

const STUB = {
  ok: false,
  code: LISTING_INCOMPLETE_CODE,
  message: "The Chrome Web Store listing is missing 2 required inputs, so the draft was not sent to review.",
  store: "chrome",
  refusedBeforeApproval: true,
  missing: MISSING,
};

describe("extension_submit relays the platform's 409 LISTING_INCOMPLETE as a list, never as a recorded submission", () => {
  const platform = useProjectRoutes("extdev-listing-incomplete-");

  it("answers listing-incomplete on publish with the rows, the bring list, the store page and no approval spent", async () => {
    if (process.platform === "win32") return;

    platform.login();
    let publishCalls = 0;

    platform.routes[`POST ${PUBLISH}`] = () => {
      publishCalls += 1;

      return { status: 409, body: STUB };
    };

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], api: API }));

    expect(publishCalls).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.status).toBe("listing-incomplete");
    expect(out.error).toMatchObject({ code: "E_PLATFORM", name: "ListingIncomplete", platformCode: LISTING_INCOMPLETE_CODE, message: STUB.message });
    expect(out.value.store).toBe("chrome");
    expect(out.value.refusedBeforeApproval).toBe(true);
    expect(out.value.missing.map((row: { id: string }) => row.id)).toEqual(["chrome.screenshots", "chrome.single_purpose"]);
    expect(out.value.bringList.readyForReview).toBe(false);
    expect(out.value.bringList.rows[0]).toMatchObject({ id: "chrome.screenshots", supply: "from your build", clearedBy: expect.stringContaining('forStore: "chrome"') });
    expect(out.value.bringList.rows[1]).toMatchObject({ id: "chrome.single_purpose", supply: "you supply" });
    expect(out.value.trackUrl).toBe("http://console.extension.localhost/acme/widget/submissions/chrome");
    expect(out.value.nextStep).toMatchObject({ kind: "screenshot", url: out.value.trackUrl });
    expect(out.value.sayToPerson).toContain("The Chrome Web Store would refuse this review: the listing still lacks 2 required inputs: Screenshots (1 to 5 images, 1280x800 or 640x400 px, JPEG or 24-bit PNG with no alpha.); Single purpose description (One sentence.). Nothing was sent to review, no approval was spent and no submission was recorded.");
    expect(out.value.sayToPerson).toContain("From your build: Screenshots (");
    expect(out.value.sayToPerson).toContain("You supply: Single purpose description (");
    expect(out.hint).toContain('extension_screenshot with forStore: "chrome"');
    expect(out.hint).toContain('sync-listing');
    expect(platform.sent("POST", "/api/cli/approvals")).toHaveLength(0);
    expect(JSON.stringify(out)).not.toMatch(/recorded as|in-review|publish-dispatched|on its way|github\.com|actions\/runs/);
  });

  it("answers listing-incomplete on a submit with dryRun false, names the sync-listing step when no image is missing, and spends no approval", async () => {
    if (process.platform === "win32") return;

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.login();
    platform.routes[`POST ${SUBMIT}`] = () => ({ status: 409, body: { ...STUB, missing: [MISSING[1]] } });

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "2bda5b2", dryRun: false, approvalId: "apr_x", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("listing-incomplete");
    expect(out.value).toMatchObject({ browsers: ["chrome"], buildSha: "2bda5b2", store: "chrome", refusedBeforeApproval: true });
    expect(out.value.missing).toHaveLength(1);
    expect(out.value.nextStep).toMatchObject({ kind: "sync-listing" });
    expect(out.value.trackUrl).toBe("http://console.extension.localhost/acme/widget/submissions/chrome");
    expect(out.value.sayToPerson).toContain("1 required input: Single purpose description (One sentence.)");
    expect(out.value.sayToPerson).toContain("no submission was recorded");
    expect(out.hint).not.toContain("forStore");
    expect(out.warnings ?? []).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/approval presented|may have spent|submitted to|github\.com|actions\/runs/);
  });

  it("reads the stub shape and its sibling spellings, and reads nothing for another code", () => {
    expect(listingIncompleteOf("EDGE_PACKAGE_HAS_ARCHIVES", STUB)).toBeNull();
    expect(listingIncompleteOf(LISTING_INCOMPLETE_CODE, "nope")).toBeNull();

    const fromItems = listingIncompleteOf(LISTING_INCOMPLETE_CODE, { store: "edge", requirements: { items: [{ ...MISSING[0], id: "edge.screenshots" }, { ...MISSING[1], id: "edge.name", status: "have" }] } });

    expect(fromItems?.store).toBe("edge");
    expect(fromItems?.missing.map((row) => row.id)).toEqual(["edge.screenshots"]);
    expect(fromItems?.bringList?.readyForReview).toBe(false);

    const empty = listingIncompleteOf(LISTING_INCOMPLETE_CODE, { store: "safari" });

    expect(empty?.missing).toEqual([]);
    expect(listingIncompleteSentence(empty!, "The App Store")).toBe("The App Store would refuse this review: the listing still lacks 0 required inputs. Nothing was sent to review, no approval was spent and no submission was recorded.");
  });
});
