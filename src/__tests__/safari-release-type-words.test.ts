import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { storeReleaseSentence, storeReleaseView } from "../lib/platform-store-releases";
import { storeMdFieldRows } from "../lib/store-md-fields";
import { listingForStore, parseStoreMdListing } from "../lib/store-md-listing";
import { releaseReadView } from "../lib/store-preflight-checks";
import { RELEASE_MODE_WORDS, releaseTypeMeaning } from "../lib/store-row-sources";
import { storePreflightView } from "../tools/store-acts";
import { safariReleaseSentence } from "../tools/store-status";
import { handler as submit } from "../tools/submit";

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

describe("a Safari release type is said with what Apple's approval does", () => {
  it("pairs each type with its meaning and offers the manual hold for a version that publishes on approval", () => {
    expect(releaseTypeMeaning("AFTER_APPROVAL")).toBe(`${AT_ONCE}; ${HOLD}`);
    expect(releaseTypeMeaning("manual")).toBe(HOLDS);
    expect(releaseTypeMeaning("SCHEDULED")).toBe("approval holds it until the date set in App Store Connect");
    expect(releaseTypeMeaning("WHENEVER")).toBe("");
    expect(releaseTypeMeaning(undefined)).toBe("");

    expect(RELEASE_MODE_WORDS.AFTER_APPROVAL).toBe(`is set to release automatically after approval: ${AT_ONCE}; ${HOLD}`);
    expect(RELEASE_MODE_WORDS.MANUAL).toBe(`is set to manual release: ${HOLDS}`);
  });

  it("says it in the release status hint for the newest Safari submission", () => {
    const sentence = safariReleaseSentence({ version: "0.1.0", releaseType: "AFTER_APPROVAL", storeVersion: { packaged: "0.1.0", displayed: "0.1.0", source: "repo", buildNumber: 7 } });

    expect(sentence).toBe(`0.1.0 is set to release automatically after approval: ${AT_ONCE}; ${HOLD}`);
  });

  it("says it on the store release row", () => {
    const row = storeReleaseView({
      id: "rel_1",
      store: "safari",
      browser: "safari",
      state: "in-review",
      storeWord: "WAITING_FOR_REVIEW",
      source: "poll",
      version: "0.1.0",
      storeVersion: { packaged: "0.1.0", displayed: "0.1.0", source: "repo", buildNumber: 7 },
      releaseType: "AFTER_APPROVAL",
      releaseTypeReadAt: READ_AT,
    });

    expect(storeReleaseSentence(row!)).toContain(`set to release automatically after approval as App Store Connect answered ${READ_AT}: ${AT_ONCE}; ${HOLD}`);
  });

  it("relays the preflight block's release read with its meaning and a sentence to say", () => {
    const view = releaseReadView({ type: "AFTER_APPROVAL", readAt: READ_AT });

    expect(view).toEqual({
      type: "AFTER_APPROVAL",
      readAt: READ_AT,
      meaning: `${AT_ONCE}; ${HOLD}`,
      say: `App Store Connect last read the version as AFTER_APPROVAL (${READ_AT}): ${AT_ONCE}; ${HOLD}.`,
    });

    const platformMeaning = "approval publishes it on the App Store at once, and an approval cannot be taken back from here";
    const block = storePreflightView(
      {
        safariPreflight: {
          act: "publish",
          blocking: [],
          warnings: ["store.safari_release_type"],
          checks: [{ id: "store.safari_release_type", label: "Approval does not publish the App Store version on its own", severity: "warn", status: "fail", actual: "AFTER_APPROVAL", message: "App Store Connect last read 0.1.0 as release automatically after approval" }],
          lock: null,
          approval: "Send App Store version 0.1.0 with TestFlight build 7 to Apple's App Review.",
          release: { type: "AFTER_APPROVAL", readAt: READ_AT, meaning: platformMeaning },
        },
      },
      "safari",
    );

    expect(block?.release).toEqual({ type: "AFTER_APPROVAL", readAt: READ_AT, meaning: platformMeaning, say: `App Store Connect last read the version as AFTER_APPROVAL (${READ_AT}): ${platformMeaning}.` });
    expect(block?.warnings).toEqual(["store.safari_release_type"]);
    expect((block?.checks as Array<{ id: string; actual?: string }>)[0]).toMatchObject({ id: "store.safari_release_type", actual: "AFTER_APPROVAL" });

    const bare = storePreflightView({ safariPreflight: { act: "publish", blocking: [], warnings: [], checks: [], lock: null, release: null } }, "safari");

    expect(bare?.release).toBeUndefined();
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

describe("extension_submit action status names what the release type means", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-release-type-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "leon",
      projectId: "prj_1",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
    });

    global.fetch = (async (url: string) => {
      const at = String(url);

      if (at.endsWith("stores/health.json")) {
        return jsonResponse({ updatedAt: READ_AT, stores: { safari: { ok: true, message: "ok", checkedAt: READ_AT } } });
      }

      if (at.endsWith("/api/cli/stores/submissions")) return jsonResponse({ ok: true, projectId: "prj_1", submissions: [LEON] });

      return jsonResponse({ message: "not found" }, false, 404);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("says in the hint that approval publishes the version at once and how to hold it", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await submit({ action: "status", browsers: ["safari"], project: "acme/leon" }));

    expect(out.ok).toBe(true);
    expect(out.value.stores[0].releaseType).toBe("AFTER_APPROVAL");
    expect(out.hint).toContain(`release type AFTER_APPROVAL (${AT_ONCE}; ${HOLD})`);
  });
});
