import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listingForStore, parseStoreMdListing } from "../lib/store-md-listing";
import { handler as submit } from "../tools/submit";
import {
  API,
  PROJECT_ROUTE,
  useProjectRoutes,
} from "./fixtures/project-routes";

const PREFLIGHT = (store: string) =>
  `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const LISTING = (store: string) => `${PROJECT_ROUTE}/stores/${store}/listing`;
const HOSTED = "https://acme.extension.dev/widget/privacy";
const SOURCE = "PRIVACY.md";
const SENTENCE = `privacy policy: published at ${HOSTED} from PRIVACY.md; edit that file to change it`;
const PENDING = `privacy policy: will be published at ${HOSTED} from PRIVACY.md once it is pushed (the platform publishes it on the push, on a listing sync or on a store settings save); that address answers 404 until then`;
const PUBLISHED_PAGE = {
  privacyPage: { url: HOSTED, state: "published", missing: [] },
};
const MISSING_LINE = (url: string) =>
  `privacy policy URL: not set; add a PRIVACY.md at the project root saying what the extension collects, why, and where it goes, and the platform publishes it at ${url} on the next push`;
const PRIVACY_MD = `# Widget privacy policy

Widget collects nothing. Nothing leaves the browser.
`;

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

const NO_SECTION = ATTESTED.replace(
  /## Privacy and data use[\s\S]*?## Chrome/,
  "## Privacy and data use\n\n- Privacy policy URL: TODO. Not strictly required.\n\n## Chrome",
);
const NOT_ATTESTED = ATTESTED.replace(
  "- Privacy policy attested: yes",
  "- Privacy policy attested: no",
);
const OWN_URL = ATTESTED.replace(
  "- Privacy policy URL:",
  "- Privacy policy URL: https://example.com/privacy",
);

function project(
  storeMd: string,
  privacyMd: string | null = PRIVACY_MD,
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-privacy-page-"));
  fs.writeFileSync(path.join(root, "STORE.md"), storeMd);

  if (privacyMd !== null) {
    fs.writeFileSync(path.join(root, "PRIVACY.md"), privacyMd);
  }

  return root;
}

const checks = (extra: Record<string, unknown> = {}) => ({
  body: {
    summary: { canSubmit: false },
    checks: [
      { id: "listing.privacy_policy_present", status: "warn" },
      { id: "listing.title_present", status: "pass" },
    ],
    ...extra,
  },
});

describe("PRIVACY.md at the project root is the project's hosted privacy policy", () => {
  const platform = useProjectRoutes("extdev-privacy-page-");

  it("parses the section's prose and the attestation line, and an empty URL line stays empty", () => {
    const parsed = parseStoreMdListing(ATTESTED);

    expect(parsed.privacy.attested).toBe(true);
    expect(parsed.privacy.section).toContain("Collected: nothing");
    expect(parsed.privacy.section).toContain("Nothing leaves the browser.");
    expect(parsed.privacy.section).not.toContain("Privacy policy");
    expect(
      listingForStore(parsed, "chrome").listing.privacyPolicyUrl,
    ).toBeUndefined();

    expect(parseStoreMdListing(NOT_ATTESTED).privacy.attested).toBe(false);
    expect(parseStoreMdListing(NO_SECTION).privacy).toEqual({
      section: "",
      attested: null,
    });

    expect(
      listingForStore(parseStoreMdListing(OWN_URL), "chrome").listing
        .privacyPolicyUrl,
    ).toBe("https://example.com/privacy");
  });

  it("preflight counts the privacy policy as covered at the derived page and says where the words come from", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () =>
      checks(PUBLISHED_PAGE);

    const out = JSON.parse(
      await submit({
        action: "preflight",
        browsers: ["chrome"],
        projectPath: project(ATTESTED),
        api: API,
      }),
    );
    const advisory = out.value.stores.chrome.storeMd;

    expect(advisory.covers).toContain(SENTENCE);
    expect(advisory.notCovered).toEqual([]);
    expect(advisory.privacyPolicy).toEqual({
      url: HOSTED,
      derived: false,
      state: "published",
      serves: true,
      source: SOURCE,
    });

    expect(out.hint).toContain(SENTENCE);
    expect(out.hint).toContain('action:"sync-listing"');
    expect(JSON.stringify(out)).not.toMatch(/accept/i);
  });

  it("preflight takes the platform's own privacy page address over the derived one", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () =>
      checks({
        privacyPageUrl: "https://registry.example.test/acme/widget/privacy",
        privacyPage: {
          url: "https://registry.example.test/acme/widget/privacy",
          state: "published",
          missing: [],
        },
      });

    const out = JSON.parse(
      await submit({
        action: "preflight",
        browsers: ["chrome"],
        projectPath: project(ATTESTED),
        api: API,
      }),
    );

    expect(out.value.stores.chrome.storeMd.privacyPolicy).toEqual({
      url: "https://registry.example.test/acme/widget/privacy",
      derived: false,
      state: "published",
      serves: true,
      source: SOURCE,
    });

    expect(out.hint).toContain(
      "privacy policy: published at https://registry.example.test/acme/widget/privacy from PRIVACY.md; edit that file to change it",
    );
  });

  it("preflight says the page will be published, never published, while the platform has not rendered it, and reconciles the warning", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () =>
      checks({
        privacyPageUrl: HOSTED,
        privacyPage: { url: HOSTED, state: "unrendered", missing: [] },
        checks: [
          {
            id: "listing.privacy_policy_present",
            status: "warn",
            message: "Privacy policy URL is not in STORE.md.",
          },
        ],
      });

    const out = JSON.parse(
      await submit({
        action: "preflight",
        browsers: ["chrome"],
        projectPath: project(ATTESTED),
        api: API,
      }),
    );
    const advisory = out.value.stores.chrome.storeMd;

    expect(advisory.covers).toContain(PENDING);
    expect(advisory.covers).not.toContain(SENTENCE);
    expect(advisory.privacyPolicy).toEqual({
      url: HOSTED,
      derived: false,
      state: "unrendered",
      serves: false,
      source: SOURCE,
    });

    expect(out.hint).toContain(PENDING);
    expect(out.hint).not.toContain("privacy policy: published at");
    expect(out.value.stores.chrome.warnings[0].message).toBe(
      "Privacy policy URL is not in STORE.md. PRIVACY.md is on disk; the platform publishes it once that file is pushed, and sync-listing links it.",
    );

    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => checks();
    const derived = JSON.parse(
      await submit({
        action: "preflight",
        browsers: ["chrome"],
        projectPath: project(ATTESTED),
        api: API,
      }),
    );
    expect(derived.value.stores.chrome.storeMd.privacyPolicy).toEqual({
      url: HOSTED,
      derived: true,
      state: "unknown",
      serves: false,
      source: SOURCE,
    });

    expect(derived.hint).toContain(PENDING);
    expect(derived.hint).not.toContain("privacy.extension.land");
  });

  it("says to add a PRIVACY.md when the file is missing, whatever STORE.md attests", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => checks();

    const attestedButNoFile = JSON.parse(
      await submit({
        action: "preflight",
        browsers: ["chrome"],
        projectPath: project(ATTESTED, null),
        api: API,
      }),
    );

    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () =>
      checks({
        privacyPageUrl: HOSTED,
        privacyPage: { url: HOSTED, state: "missing-file", missing: ["file"] },
      });

    const platformNamed = JSON.parse(
      await submit({
        action: "preflight",
        browsers: ["chrome"],
        projectPath: project(NO_SECTION, null),
        api: API,
      }),
    );

    expect(attestedButNoFile.value.stores.chrome.storeMd.notCovered).toEqual([
      MISSING_LINE(HOSTED),
    ]);

    expect(
      attestedButNoFile.value.stores.chrome.storeMd.privacyPolicy,
    ).toBeUndefined();

    expect(attestedButNoFile.value.stores.chrome.storeMd.covers).not.toContain(
      SENTENCE,
    );

    expect(platformNamed.value.stores.chrome.storeMd.notCovered).toEqual([
      MISSING_LINE(HOSTED),
    ]);

    expect(JSON.stringify([attestedButNoFile, platformNamed])).not.toMatch(
      /accept/i,
    );

    expect(JSON.stringify([attestedButNoFile, platformNamed])).not.toContain(
      "attested",
    );
  });

  it("sync-listing writes the hosted page as the listing's privacy policy URL and says so", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({
      body: { checks: [] },
    });

    platform.routes[`PUT ${LISTING("chrome")}`] = () => ({
      body: {
        changes: [`privacyPolicyUrl: "" -> "${HOSTED}"`],
        privacyPage: { url: HOSTED, state: "published", missing: [] },
      },
    });

    const out = JSON.parse(
      await submit({
        action: "sync-listing",
        browsers: ["chrome"],
        projectPath: project(ATTESTED),
        api: API,
      }),
    );
    const put = platform.sent("PUT", LISTING("chrome"))[0]!.body;

    expect(put.listing.privacyPolicyUrl).toBe(HOSTED);
    expect(out.status).toBe("listing-synced");
    expect(out.value.stores.chrome.filled).toContain("privacyPolicyUrl");
    expect(out.value.stores.chrome.privacyPolicy).toEqual({
      url: HOSTED,
      derived: true,
      state: "published",
      serves: true,
      source: SOURCE,
    });

    expect(out.value.stores.chrome.privacyPage).toBeUndefined();
    expect(out.hint).toContain(SENTENCE);
    expect(out.hint).toContain(
      "cannot be written through Google's API: paste them once in the item's dashboard",
    );

    expect(out.hint).not.toContain("a submission sends it");
    expect(JSON.stringify(out)).not.toMatch(/accept/i);
  });

  it("sync-listing leaves the privacy policy URL alone when STORE.md names its own or there is no PRIVACY.md", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({
      body: { checks: [] },
    });

    platform.routes[`PUT ${LISTING("chrome")}`] = () => ({
      body: { changes: [] },
    });

    const own = JSON.parse(
      await submit({
        action: "sync-listing",
        browsers: ["chrome"],
        projectPath: project(OWN_URL),
        api: API,
      }),
    );
    const ownPut = platform.sent("PUT", LISTING("chrome"))[0]!.body;
    const readsBefore = platform.sent("POST", PREFLIGHT("chrome")).length;
    const unattested = JSON.parse(
      await submit({
        action: "sync-listing",
        browsers: ["chrome"],
        projectPath: project(ATTESTED, null),
        api: API,
      }),
    );
    const unattestedPut = platform.sent("PUT", LISTING("chrome"))[1]!.body;

    expect(ownPut.listing.privacyPolicyUrl).toBe("https://example.com/privacy");
    expect(own.value.stores.chrome.privacyPolicy).toBeUndefined();
    expect(own.hint).not.toContain("privacy policy: published");
    expect(unattestedPut.listing.privacyPolicyUrl).toBeUndefined();
    expect(unattested.value.stores.chrome.privacyPolicy).toBeUndefined();
    expect(
      platform.sent("POST", PREFLIGHT("chrome")).length - readsBefore,
    ).toBe(1);
  });
});
