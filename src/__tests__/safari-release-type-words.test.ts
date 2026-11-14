import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { storeMdFieldRows } from "../lib/store-md-fields";
import { listingForStore, parseStoreMdListing } from "../lib/store-md-listing";

const AT_ONCE = "approval publishes it on the App Store at once, and an approval cannot be taken back from here";
const HOLD = "the review act sets it to manual release before sending it to App Review unless STORE.md states `- Release: after approval` under `## Safari`, and the record names the change in publish.releaseTypeChanged";
const HOLDS = "approval holds it until you release it";
const READ_AT = "2026-10-31T11:35:00.000Z";

const STORE_MD = (safariLines: string) => `# Store metadata

## Listing

- Name: Leon
- Summary: Reads the page aloud.

## Safari

- App Store name: Leon Reader
${safariLines}
### Reviewer notes

Nothing to say.
`;

describe("the Release line under ## Safari", () => {
  it("reads manual or after approval as the Safari listing's release intent, for Safari alone", () => {
    const manual = parseStoreMdListing(STORE_MD("- Release: manual\n"));

    expect(listingForStore(manual, "safari").listing.releaseMode).toBe("manual");
    expect(listingForStore(manual, "chrome").listing.releaseMode).toBeUndefined();

    const after = parseStoreMdListing(STORE_MD("- Release: after approval\n"));

    expect(listingForStore(after, "safari").listing.releaseMode).toBe("after approval");
    expect(listingForStore(parseStoreMdListing(STORE_MD("- Version release: Manual\n")), "safari").listing.releaseMode).toBe("Manual");
    expect(listingForStore(parseStoreMdListing(STORE_MD("")), "safari").listing.releaseMode).toBeUndefined();
  });

  it("names the line in the Safari field reference, with manual as the default when it is absent", () => {
    const row = storeMdFieldRows("safari").find((item) => item.field === "releaseMode");

    expect(row?.line).toBe("- Release:");
    expect(row?.section).toBe("## Safari");
    expect(JSON.stringify(row)).toContain("manual, the least public, when the line is absent");
    expect(storeMdFieldRows("chrome").some((item) => item.field === "releaseMode")).toBe(false);
  });
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const LEON = {
  id: "sub_safari_7",
  store: "safari",
  channel: "stable",
  buildId: "63f0d41",
  version: "0.1.0",
  status: "in-review",
  submittedAt: "2026-10-31T10:00:00.000Z",
  storeUrl: null,
  run: null,
  storeVersion: { packaged: "0.1.0", displayed: "0.1.0", source: "repo", buildNumber: 7 },
  storeReview: { state: "WAITING_FOR_REVIEW", checkedAt: READ_AT, source: "poll" },
  statusRead: { word: "in-review", readAt: READ_AT, source: "poll", storeWord: "WAITING_FOR_REVIEW" },
  appStoreRelease: { type: "AFTER_APPROVAL", readAt: READ_AT },
};
