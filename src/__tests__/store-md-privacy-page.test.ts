import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listingForStore, parseStoreMdListing } from "../lib/store-md-listing";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const LISTING = (store: string) => `${PROJECT_ROUTE}/stores/${store}/listing`;
const HOSTED = "https://acme.extension.land/widget/privacy";
const SOURCE = "STORE.md Privacy and data use section";
const SENTENCE = `privacy policy: published at ${HOSTED} from STORE.md's Privacy section; edit that section to change it`;
const SECTION_LINE = 'privacy policy URL: not in STORE.md; add a "## Privacy and data use" section saying what the extension collects and, under it, the line "- Privacy policy attested: yes", and the platform publishes that section as a public privacy policy URL the stores can link';
const ATTESTED_LINE = 'privacy policy URL: not in STORE.md; add the line "- Privacy policy attested: yes" under "## Privacy and data use" and the platform publishes that section as a public privacy policy URL the stores can link';

const ATTESTED = `# Store metadata

## Listing

- Name: PII Shield
- Summary: Hide personal information on every open tab with one click.

## Privacy and data use

- Collected: nothing. The extension sends no user data to any server.
- storage: keeps the extension's own settings on the user's device.
- Not collected: browsing history, page content, and usage analytics.
  Nothing leaves the browser.
- Privacy policy URL:
- Privacy policy attested: yes

## Chrome Web Store

### Single purpose

Hide personal information on the pages the user has open, on demand.
`;

const NO_SECTION = ATTESTED.replace(/## Privacy and data use[\s\S]*?## Chrome/, "## Privacy and data use\n\n- Privacy policy URL: TODO. Not strictly required.\n\n## Chrome");
const NOT_ATTESTED = ATTESTED.replace("- Privacy policy attested: yes", "- Privacy policy attested: no");
const OWN_URL = ATTESTED.replace("- Privacy policy URL:", "- Privacy policy URL: https://example.com/privacy");

function project(storeMd: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-privacy-page-"));
  fs.writeFileSync(path.join(root, "STORE.md"), storeMd);

  return root;
}

const checks = (extra: Record<string, unknown> = {}) => ({
  body: { summary: { canSubmit: false }, checks: [{ id: "listing.privacy_policy_present", status: "warn" }, { id: "listing.title_present", status: "pass" }], ...extra },
});

describe("STORE.md's Privacy and data use section is the project's privacy policy once attested", () => {
  const platform = useProjectRoutes("extdev-privacy-page-");

  it("parses the section's prose and the attestation line, and an empty URL line stays empty", () => {
    const parsed = parseStoreMdListing(ATTESTED);

    expect(parsed.privacy.attested).toBe(true);
    expect(parsed.privacy.section).toContain("Collected: nothing");
    expect(parsed.privacy.section).toContain("Nothing leaves the browser.");
    expect(parsed.privacy.section).not.toContain("Privacy policy");
    expect(listingForStore(parsed, "chrome").listing.privacyPolicyUrl).toBeUndefined();
    expect(parseStoreMdListing(NOT_ATTESTED).privacy.attested).toBe(false);
    expect(parseStoreMdListing(NO_SECTION).privacy).toEqual({ section: "", attested: null });
    expect(listingForStore(parseStoreMdListing(OWN_URL), "chrome").listing.privacyPolicyUrl).toBe("https://example.com/privacy");
  });

  it("preflight counts the privacy policy as covered at the derived page and says where the words come from", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => checks();

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: project(ATTESTED), api: API }));
    const advisory = out.value.stores.chrome.storeMd;

    expect(advisory.covers).toContain(SENTENCE);
    expect(advisory.notCovered).toEqual([]);
    expect(advisory.privacyPolicy).toEqual({ url: HOSTED, derived: true, source: SOURCE });
    expect(out.hint).toContain(SENTENCE);
    expect(out.hint).toContain('action:"sync-listing"');
    expect(JSON.stringify(out)).not.toMatch(/accept/i);
  });

  it("preflight takes the platform's own privacy page address over the derived one", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => checks({ privacyPageUrl: "https://registry.example.test/acme/widget/privacy" });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: project(ATTESTED), api: API }));

    expect(out.value.stores.chrome.storeMd.privacyPolicy).toEqual({ url: "https://registry.example.test/acme/widget/privacy", derived: false, source: SOURCE });
    expect(out.hint).toContain("privacy policy: published at https://registry.example.test/acme/widget/privacy from STORE.md's Privacy section; edit that section to change it");
  });

  it("names the exact STORE.md line to add when the attestation or the whole section is missing", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => checks();

    const unattested = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: project(NOT_ATTESTED), api: API }));
    const sectionless = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: project(NO_SECTION), api: API }));

    expect(unattested.value.stores.chrome.storeMd.notCovered).toEqual([ATTESTED_LINE]);
    expect(unattested.value.stores.chrome.storeMd.privacyPolicy).toBeUndefined();
    expect(unattested.value.stores.chrome.storeMd.covers).not.toContain(SENTENCE);
    expect(sectionless.value.stores.chrome.storeMd.notCovered).toEqual([SECTION_LINE]);
    expect(JSON.stringify([unattested, sectionless])).not.toMatch(/accept/i);
  });

  it("sync-listing writes the hosted page as the listing's privacy policy URL and says so", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: { checks: [] } });
    platform.routes[`PUT ${LISTING("chrome")}`] = () => ({ body: { changes: [`privacyPolicyUrl: "" -> "${HOSTED}"`] } });

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome"], projectPath: project(ATTESTED), api: API }));
    const put = platform.sent("PUT", LISTING("chrome"))[0]!.body;

    expect(put.listing.privacyPolicyUrl).toBe(HOSTED);
    expect(out.status).toBe("listing-synced");
    expect(out.value.stores.chrome.filled).toContain("privacyPolicyUrl");
    expect(out.value.stores.chrome.privacyPolicy).toEqual({ url: HOSTED, derived: true, source: SOURCE });
    expect(out.hint).toContain(SENTENCE);
    expect(JSON.stringify(out)).not.toMatch(/accept/i);
  });

  it("sync-listing leaves the privacy policy URL alone when STORE.md names its own or is not attested", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: { checks: [] } });
    platform.routes[`PUT ${LISTING("chrome")}`] = () => ({ body: { changes: [] } });

    const own = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome"], projectPath: project(OWN_URL), api: API }));
    const ownPut = platform.sent("PUT", LISTING("chrome"))[0]!.body;
    const readsBefore = platform.sent("POST", PREFLIGHT("chrome")).length;
    const unattested = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome"], projectPath: project(NOT_ATTESTED), api: API }));
    const unattestedPut = platform.sent("PUT", LISTING("chrome"))[1]!.body;

    expect(ownPut.listing.privacyPolicyUrl).toBe("https://example.com/privacy");
    expect(own.value.stores.chrome.privacyPolicy).toBeUndefined();
    expect(own.hint).not.toContain("privacy policy: published");
    expect(unattestedPut.listing.privacyPolicyUrl).toBeUndefined();
    expect(unattested.value.stores.chrome.privacyPolicy).toBeUndefined();
    expect(platform.sent("POST", PREFLIGHT("chrome")).length - readsBefore).toBe(1);
  });
});
