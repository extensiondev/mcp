import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { listingDigest } from "../lib/store-listing-media";
import { STORE_FIELDS, listingForStore, parseStoreMdListing } from "../lib/store-md-listing";
import { TOOL_POLICY } from "../lib/tool-policy";
import { handler as submit, schema } from "../tools/submit";
import {
  API,
  PROJECT_ROUTE,
  useProjectRoutes,
} from "./fixtures/project-routes";

const LISTING = (store: string) => `${PROJECT_ROUTE}/stores/${store}/listing`;
const PREFLIGHT = (store: string) =>
  `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const APPROVALS = "/api/cli/approvals";

const STORE_MD = `# Store metadata

## Listing

- Name: PII Shield
- Summary: Hide personal information on every open tab with one click.
- Description:

  Sharing your screen? Click PII Shield and names
  are blurred on every open tab.

  Detection happens on your computer.

- Category: Productivity (Chrome Web Store), Privacy & Security (Firefox and
  Edge).
- Screenshots: TODO at least one 1280x800 screenshot per store.

## Privacy and data use

- Privacy policy URL: TODO. Not strictly required.

## Chrome Web Store

### Single purpose

Hide personal information on the pages the user has open, on demand.

### Permissions justification

- storage: Remembers whether the shield is on.
- scripting: Adds the hiding script to tabs that were already
  open before install.

## Firefox Add-ons

### Reviewer notes

To test: click the toolbar button.

### Release notes

TODO user-facing notes.
`;

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);

  return bytes;
}

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-listing-"));
  fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);
  fs.mkdirSync(path.join(root, "dist", "chrome", "icons"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "dist", "chrome", "manifest.json"),
    JSON.stringify({ icons: { "16": "icons/16.png", "128": "icons/128.png" } }),
  );

  fs.writeFileSync(
    path.join(root, "dist", "chrome", "icons", "128.png"),
    png(128, 128),
  );

  fs.mkdirSync(path.join(root, "shots"));
  fs.writeFileSync(path.join(root, "shots", "popup.png"), png(1280, 800));

  return root;
}

describe("STORE.md fills the store listing", () => {
  it("reads the listing copy, per store categories and notes, and leaves TODO lines out", () => {
    const parsed = parseStoreMdListing(STORE_MD);
    const chrome = listingForStore(parsed, "chrome").listing;
    const firefox = listingForStore(parsed, "firefox").listing;

    expect(chrome).toMatchObject({
      title: "PII Shield",
      shortDescription:
        "Hide personal information on every open tab with one click.",
      fullDescription:
        "Sharing your screen? Click PII Shield and names are blurred on every open tab.\n\nDetection happens on your computer.",
      categories: ["Productivity"],
      singlePurpose:
        "Hide personal information on the pages the user has open, on demand.",
    });

    expect(chrome.permissionJustifications).toEqual([
      {
        permission: "storage",
        justification: "Remembers whether the shield is on.",
      },
      {
        permission: "scripting",
        justification:
          "Adds the hiding script to tabs that were already open before install.",
      },
    ]);

    expect(chrome.privacyPolicyUrl).toBeUndefined();
    expect(firefox).toMatchObject({
      categories: ["Privacy & Security"],
      reviewerNotes: "To test: click the toolbar button.",
    });

    expect(firefox.releaseNotes).toBeUndefined();
  });

  it("takes one category up to its store note for every store and keeps the note out", () => {
    const parsed = parseStoreMdListing(
      STORE_MD.replace(
        "- Category: Productivity (Chrome Web Store), Privacy & Security (Firefox and\n  Edge).",
        "- Category: Privacy & Security (Chrome Web Store)",
      ),
    );

    expect(listingForStore(parsed, "chrome").listing.categories).toEqual([
      "Privacy & Security",
    ]);

    expect(listingForStore(parsed, "firefox").listing.categories).toEqual([
      "Privacy & Security",
    ]);

    expect(listingForStore(parsed, "firefox").unread).toEqual({});
  });

  it("reads a bare category for every store", () => {
    const parsed = parseStoreMdListing(
      STORE_MD.replace(
        "- Category: Productivity (Chrome Web Store), Privacy & Security (Firefox and\n  Edge).",
        "- Category: Productivity",
      ),
    );

    expect(listingForStore(parsed, "chrome").listing.categories).toEqual([
      "Productivity",
    ]);

    expect(listingForStore(parsed, "edge").listing.categories).toEqual([
      "Productivity",
    ]);
  });

  it("keeps a trailing note out of the license, support email and homepage", () => {
    const parsed = parseStoreMdListing(
      STORE_MD.replace(
        "- Screenshots:",
        [
          "- License: MIT (see LICENSE)",
          "- Support email: help@example.com (answered within a week)",
          "- Homepage: https://example.com (the landing page)",
          "- Screenshots:",
        ].join("\n"),
      ),
    );
    const firefox = listingForStore(parsed, "firefox");

    expect(firefox.listing).toMatchObject({
      license: "MIT",
      supportEmail: "help@example.com",
      homepageUrl: "https://example.com",
    });

    expect(firefox.skipped).toEqual([]);
    expect(firefox.unread).toEqual({});
  });

  it("names the line it could not take and the shape it reads", () => {
    const parsed = parseStoreMdListing(
      STORE_MD.replace(
        "- Category: Productivity (Chrome Web Store), Privacy & Security (Firefox and\n  Edge).",
        [
          "- Category: Productivity (Chrome Web Store), Tools (Edge)",
          "- Support email: help at example dot com",
        ].join("\n"),
      ),
    );
    const firefox = listingForStore(parsed, "firefox");

    expect(firefox.listing.categories).toBeUndefined();
    expect(firefox.listing.supportEmail).toBeUndefined();
    expect(firefox.unread).toEqual({
      categories: { line: "- Category:", reason: "names chrome and edge only" },
      supportEmail: {
        line: "- Support email:",
        reason: "is not an email address",
      },
    });

    expect(listingForStore(parsed, "edge").listing.categories).toEqual([
      "Tools",
    ]);
  });

  it("reads a subtitle and search terms for the App Store and refuses each over its limit", () => {
    const withLines = (subtitle: string, terms: string) =>
      parseStoreMdListing(
        STORE_MD.replace(
          "- Screenshots:",
          [`- Subtitle: ${subtitle}`, `- Search terms: ${terms}`, "- Screenshots:"].join("\n"),
        ),
      );
    const safari = listingForStore(withLines("Blur names on every tab", "privacy, redact, pii"), "safari");

    expect(safari.listing).toMatchObject({
      subtitle: "Blur names on every tab",
      searchTerms: ["privacy", "redact", "pii"],
    });

    expect(safari.skipped).toEqual([]);
    expect(listingForStore(withLines("Blur names", "privacy"), "chrome").listing).not.toHaveProperty("subtitle");
    expect(listingForStore(withLines("Blur names", "privacy"), "chrome").listing).not.toHaveProperty("searchTerms");
    expect(listingForStore(withLines("Blur names", "privacy"), "edge").listing.searchTerms).toEqual(["privacy"]);

    const long = listingForStore(
      withLines("Blur every name on every open tab now", Array.from({ length: 12 }, (_, i) => `keyword-${i}`).join(", ")),
      "safari",
    );

    expect(long.listing).not.toHaveProperty("subtitle");
    expect(long.listing).not.toHaveProperty("searchTerms");
    expect(long.skipped).toEqual([
      "subtitle in STORE.md is 37 characters, over the 30 the listing takes, so it was left out",
      "searchTerms in STORE.md is 121 characters joined by commas, over the 100 the App Store keywords take, so it was left out",
    ]);

    expect(long.unread.subtitle).toEqual({ line: "- Subtitle:", reason: "is 37 characters, over the 30 the listing takes" });
    expect(listingForStore(withLines("Blur names", "privacy"), "edge").skipped).toEqual([]);
  });

  it("reads the App Store lines under the Safari section and takes the review contact phone in E.164 only", () => {
    const withSafari = (phone: string) =>
      parseStoreMdListing(
        `${STORE_MD}\n## Safari\n\n- Subtitle: Blur names on screen\n- Search terms: privacy, redact\n- Review contact phone: ${phone}\n\n### Reviewer notes\n\nClick the toolbar button.\n`,
      );
    const safari = listingForStore(withSafari("+55 (11) 99999-9999"), "safari");

    expect(safari.listing).toMatchObject({
      subtitle: "Blur names on screen",
      searchTerms: ["privacy", "redact"],
      reviewContactPhone: "+5511999999999",
    });

    expect(safari.skipped).toEqual([]);
    expect(listingForStore(withSafari("+5511999999999"), "chrome").listing).not.toHaveProperty("reviewContactPhone");
    expect(listingForStore(withSafari("+5511999999999"), "chrome").listing).not.toHaveProperty("searchTerms");

    const bare = listingForStore(withSafari("11 99999 9999"), "safari");

    expect(bare.listing).not.toHaveProperty("reviewContactPhone");
    expect(bare.skipped).toEqual([
      "reviewContactPhone in STORE.md is not an E.164 phone number (a plus, the country code and the digits, for example +5511999999999), so it was left out",
    ]);

    expect(bare.unread.reviewContactPhone?.line).toBe("- Review contact phone:");
  });

  it("hashes the vector the platform pins to the same digest", () => {
    const icon = {
      sha256: "a".repeat(64),
      width: 128,
      height: 128,
      bytes: Buffer.alloc(0),
      source: "x",
    };

    expect(
      listingDigest({
        listing: {
          title: "PII Shield",
          shortDescription: "Hide it.",
          categories: ["Productivity"],
          permissionJustifications: [
            { permission: "storage", justification: "Settings." },
          ],
        },
        icons: [icon],
      }),
    ).toBe("140c4c8fb822aab0a502affa88bdfc97da96392892e41e23755df07f14fa100b");
  });

  it("is an action of extension_submit that counts as shipping", () => {
    expect(schema.inputSchema.properties.action.enum).toContain("sync-listing");

    const ships = TOOL_POLICY.extension_submit.ships as (
      args: Record<string, unknown>,
    ) => boolean;

    expect(ships({ action: "sync-listing" })).toBe(true);
  });
});

describe("extension_submit sync-listing and the preflight advisory", () => {
  const platform = useProjectRoutes("extdev-sync-listing-");
  let root = "";

  beforeEach(() => {
    root = project();
  });

  it("asks for an owner's approval of the computed change, then writes once with it", async () => {
    if (process.platform === "win32") return;

    platform.login();

    platform.routes[`PUT ${LISTING("chrome")}`] = (call) => {
      if (call.body.approvalId) {
        return {
          body: {
            ok: true,
            store: "chrome",
            changes: ['title: "" -> "PII Shield"'],
          },
        };
      }

      const scope = { store: "chrome", listingDigest: "0".repeat(64) };
      const ours = actionFingerprint("extension_store.listing", scope);

      return {
        status: 403,
        body: {
          code: "APPROVAL_REQUIRED",
          message: "Needs approval.",
          approvalRequest: {
            action: "extension_store.listing",
            scope,
            fingerprint: ours,
          },
          digest: { platform: STORE_FIELDS.chrome, client: STORE_FIELDS.chrome, differ: [] },
        },
      };
    };

    const mismatch = JSON.parse(
      await submit({
        action: "sync-listing",
        browsers: ["chrome"],
        projectPath: root,
        api: API,
      }),
    );

    expect(mismatch.status).toBe("sync-listing-refused");
    expect(mismatch.error.message).toContain("hashes this listing differently");
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);

    platform.routes[`PUT ${LISTING("chrome")}`] = (call) => {
      if (call.body.approvalId) {
        return {
          body: {
            ok: true,
            store: "chrome",
            changes: ['title: "" -> "PII Shield"'],
          },
        };
      }

      const parsedScope = {
        store: "chrome",
        listingDigest: digestOf(call.body),
      };

      return {
        status: 403,
        body: {
          code: "APPROVAL_REQUIRED",
          message: "Needs approval.",
          approvalRequest: {
            action: "extension_store.listing",
            scope: parsedScope,
            fingerprint: actionFingerprint(
              "extension_store.listing",
              parsedScope,
            ),
          },
        },
      };
    };

    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: {
        approvalId: "apr_l",
        approvalUrl: `${API}/device/approve/apr_l`,
        description: "Change the Chrome Web Store listing of widget.",
        changes: ['title: "" -> "PII Shield"'],
      },
    });

    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({
      body: {
        checks: [
          { id: "listing.chrome_screenshots_present", status: "fail" },
          { id: "listing.privacy_policy_present", status: "warn" },
          { id: "listing.title_present", status: "pass" },
        ],
      },
    });

    const asked = JSON.parse(
      await submit({
        action: "sync-listing",
        browsers: ["chrome"],
        projectPath: root,
        screenshots: ["shots/popup.png"],
        api: API,
      }),
    );

    expect(asked.status).toBe("approval-required");
    expect(asked.value.approvalUrl).toBe(`${API}/device/approve/apr_l`);
    expect(asked.value.stores.chrome.changes).toEqual([
      'title: "" -> "PII Shield"',
    ]);

    const request = platform.sent("POST", APPROVALS)[0]!.body;
    expect(request.action).toBe("extension_store.listing");
    expect(request.store).toBe("chrome");
    expect(request.media.icons[0]).toMatchObject({ width: 128, height: 128 });
    expect(request.media.icons[0].dataBase64).toBeUndefined();
    expect(request.media.screenshots[0]).toMatchObject({
      width: 1280,
      height: 800,
    });

    const written = JSON.parse(
      await submit({
        action: "sync-listing",
        browsers: ["chrome"],
        projectPath: root,
        screenshots: ["shots/popup.png"],
        approvalId: "apr_l",
        api: API,
      }),
    );
    const put = platform.sent("PUT", LISTING("chrome")).slice(-1)[0]!.body;

    expect(put.approvalId).toBe("apr_l");
    expect(put.listing.title).toBe("PII Shield");
    expect(
      Buffer.from(put.media.icons[0].dataBase64, "base64").readUInt32BE(16),
    ).toBe(128);

    expect(written.status).toBe("listing-synced");
    expect(written.value.stores.chrome.stillBlocking).toEqual([
      "listing.chrome_screenshots_present",
      "listing.privacy_policy_present (warning)",
    ]);

    expect(written.hint).toContain("chrome still lacks");
  });

  const safariSync = (extra: Record<string, unknown> = {}) =>
    submit({ action: "sync-listing", browsers: ["safari"], projectPath: root, approvalId: "apr_s", api: API, ...extra });
  const SUBMISSIONS = "http://console.extension.localhost/acme/widget/submissions/safari";

  it("answers the App Store Connect push as a state and never names the run it started", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({ body: { checks: [] } });

    const answers: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
      [
        { status: "dispatched", runState: "queued", runUrl: "https://github.com/extensiondev/1--prj_app/actions/runs/77", workflowRunId: 77, dispatchId: "d-1" },
        { status: "dispatched", runState: "queued" },
        "The App Store Connect push is queued; say preflight in a minute and I read what landed.",
      ],
      [
        { status: "dispatched", runState: "running", runUrl: "https://github.com/extensiondev/1--prj_app/actions/runs/77" },
        { status: "dispatched", runState: "running" },
        "The App Store Connect push is running; say preflight in a minute and I read what landed.",
      ],
      [
        { status: "dispatched" },
        { status: "dispatched" },
        "The App Store Connect push is dispatched; say preflight in a minute and I read what landed.",
      ],
      [
        {
          status: "failed",
          runState: "failed",
          failedStep: "chmod scripts/store/safari-listing.sh",
          retryHint: "The mirror is missing the listing scripts; the next mirror sync adds them, then sync-listing again",
          runUrl: "https://github.com/extensiondev/1--prj_app/actions/runs/78",
        },
        {
          status: "failed",
          runState: "failed",
          failedStep: "chmod scripts/store/safari-listing.sh",
          retryHint: "The mirror is missing the listing scripts; the next mirror sync adds them, then sync-listing again",
        },
        "The App Store Connect push failed at chmod scripts/store/safari-listing.sh. The mirror is missing the listing scripts; the next mirror sync adds them, then sync-listing again. Say sync-listing again.",
      ],
      [
        { status: "landed", runState: "landed", fieldsWritten: 8, checkedAt: "2026-10-23T15:00:00.000Z" },
        { status: "landed", runState: "landed", fieldsWritten: 8, checkedAt: "2026-10-23T15:00:00.000Z" },
        "The push wrote 8 fields to App Store Connect at October 23, 2026 at 15:00 UTC.",
      ],
      [
        { dispatched: true, dispatchId: "d-1", workflowRunId: 77, workflowRunUrl: "https://github.com/extensiondev/1--prj_app/actions/runs/77", runCorrelation: "run-name" },
        { status: "dispatched" },
        "The App Store Connect push is dispatched; say preflight in a minute and I read what landed.",
      ],
      [
        { dispatched: false, reason: "workflow-stale", message: "This project's store workflow does not know the listing push yet." },
        { status: "failed", reason: "This project's store workflow does not know the listing push yet." },
        "The App Store Connect push failed: This project's store workflow does not know the listing push yet. Say sync-listing again.",
      ],
    ];

    for (const [raw, state, say] of answers) {
      platform.routes[`PUT ${LISTING("safari")}`] = () => ({
        body: { ok: true, store: "safari", changes: ['title: "" -> "PII Shield"'], appStoreConnect: raw },
      });

      const written = JSON.parse(await safariSync());

      expect(written.status).toBe("listing-synced");
      expect(written.value.stores.safari.appStoreConnect).toEqual({ ...state, trackUrl: SUBMISSIONS });
      expect(written.value.sayToPerson).toBe(say);
      expect(written.hint).toContain(say);

      const answer = JSON.stringify(written);
      expect(answer).not.toContain("actions/runs");
      expect(answer).not.toContain("1--prj_app");
      expect(answer).not.toContain("runUrl");
      expect(answer).not.toContain("workflowRunId");
      expect(answer).not.toContain("dispatchId");
      expect(answer).not.toContain("run-name");
    }
  });

  it("says the failed push's next step from its reason when the platform gives no retry hint", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({ body: { checks: [] } });

    const nexts: Array<[string, string]> = [
      ["The App Store Connect key was refused (401).", "Connect the App Store in the console store settings, then say sync-listing again."],
      ["The description is over the listing's limit.", "Fix STORE.md, then say sync-listing again."],
      ["The runner was lost.", "Say sync-listing again."],
    ];

    for (const [reason, next] of nexts) {
      platform.routes[`PUT ${LISTING("safari")}`] = () => ({
        body: { ok: true, store: "safari", changes: [], appStoreConnect: { status: "failed", reason } },
      });

      const written = JSON.parse(await safariSync());

      expect(written.value.sayToPerson).toBe(`The App Store Connect push failed: ${reason} ${next}`);
    }
  });

  it("names what App Store Connect still owes with the STORE.md line for each field", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({ body: { checks: [] } });
    platform.routes[`PUT ${LISTING("safari")}`] = () => ({
      body: {
        ok: true,
        store: "safari",
        changes: [],
        appStoreConnect: {
          status: "landed",
          runState: "landed",
          fieldsWritten: 7,
          landedAt: "2026-10-23T15:10:00.000Z",
          owed: [
            { field: "contactPhone", reason: "contactPhone required" },
            { field: "subtitle", reason: "empty" },
          ],
          warnings: ["keywords were cut to 100 characters"],
        },
      },
    });

    const written = JSON.parse(await safariSync());

    expect(written.value.stores.safari.appStoreConnect).toMatchObject({
      status: "landed",
      owed: [
        { field: "contactPhone", reason: "contactPhone required" },
        { field: "subtitle", reason: "empty" },
      ],
      warnings: ["keywords were cut to 100 characters"],
    });

    expect(written.value.sayToPerson).toBe(
      "The push wrote 7 fields to App Store Connect at October 23, 2026 at 15:10 UTC. App Store Connect still needs: contactPhone (contactPhone required), subtitle (empty); add `- Review contact phone:` and `- Subtitle:` under the Safari section and say sync-listing again.",
    );
  });

  it("sends an unchanged safari listing again with force when no push ever landed", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({ body: { checks: [] } });
    platform.routes[`PUT ${LISTING("safari")}`] = (call) =>
      call.body.force === true
        ? {
            body: {
              ok: true,
              store: "safari",
              changes: [],
              appStoreConnect: { status: "dispatched", runState: "queued", runUrl: "https://github.com/extensiondev/1--prj_app/actions/runs/79" },
            },
          }
        : {
            status: 409,
            body: { code: "NO_CHANGE", message: "The listing already reads this way.", appStoreConnect: { status: "unchanged", runState: "unknown" } },
          };

    const resent = JSON.parse(await safariSync());
    const puts = platform.sent("PUT", LISTING("safari"));

    expect(puts).toHaveLength(2);
    expect(puts[0]!.body.force).toBeUndefined();
    expect(puts[1]!.body.force).toBe(true);
    expect(puts[1]!.body.listing.title).toBe("PII Shield");
    expect(puts[1]!.body.approvalId).toBe("apr_s");
    expect(resent.status).toBe("listing-synced");
    expect(resent.value.stores.safari).toMatchObject({ status: "synced", appStoreConnect: { status: "dispatched", runState: "queued", trackUrl: SUBMISSIONS } });
    expect(resent.value.sayToPerson).toBe("The App Store Connect push is queued; say preflight in a minute and I read what landed.");
    expect(JSON.stringify(resent)).not.toContain("actions/runs");

    platform.calls.length = 0;
    platform.routes[`PUT ${LISTING("safari")}`] = () => ({
      status: 409,
      body: { code: "NO_CHANGE", message: "The listing already reads this way.", appStoreConnect: { status: "unchanged", runState: "landed", landedAt: "2026-10-23T15:10:00.000Z" } },
    });

    const landed = JSON.parse(await safariSync());

    expect(platform.sent("PUT", LISTING("safari"))).toHaveLength(1);
    expect(landed.status).toBe("listing-synced");
    expect(landed.value.outcome.status).toBe("unchanged");
    expect(landed.value.stores.safari).toMatchObject({ status: "unchanged", appStoreConnect: { status: "unchanged", runState: "landed", trackUrl: SUBMISSIONS } });
    expect(landed.value.sayToPerson).toBe(
      "The listing is unchanged and its last App Store Connect push landed at October 23, 2026 at 15:10 UTC; say preflight and I read what it carries.",
    );
  });

  it("answers unchanged with the note when an older platform refuses the forced resend", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({ body: { checks: [] } });

    const refusals: Array<(force: unknown) => { status: number; body: Record<string, unknown> }> = [
      (force) =>
        force === true
          ? { status: 400, body: { code: "BAD_REQUEST", message: "Unknown field force." } }
          : { status: 409, body: { code: "NO_CHANGE", message: "The listing already reads this way." } },
      () => ({ status: 409, body: { code: "NO_CHANGE", message: "The listing already reads this way." } }),
    ];

    for (const refusal of refusals) {
      platform.calls.length = 0;
      platform.routes[`PUT ${LISTING("safari")}`] = (call) => refusal(call.body.force);

      const unchanged = JSON.parse(await safariSync());
      const puts = platform.sent("PUT", LISTING("safari"));

      expect(puts).toHaveLength(2);
      expect(puts[1]!.body.force).toBe(true);
      expect(unchanged.status).toBe("listing-synced");
      expect(unchanged.value.outcome.status).toBe("unchanged");
      expect(unchanged.value.stores.safari).toEqual({
        store: "safari",
        status: "unchanged",
        appStoreConnect: { status: "unchanged", resend: "refused", trackUrl: SUBMISSIONS },
        filled: ["title", "shortDescription", "fullDescription", "icons"],
        stillBlocking: [],
      });

      expect(unchanged.value.sayToPerson).toBe(
        "The listing is unchanged and no App Store Connect push has landed; the platform cannot resend an unchanged listing yet.",
      );
    }

    platform.calls.length = 0;
    platform.routes[`PUT ${LISTING("chrome")}`] = () => ({ status: 409, body: { code: "NO_CHANGE", message: "The listing already reads this way." } });
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: { checks: [] } });

    const chrome = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome"], projectPath: root, approvalId: "apr_c", api: API }));

    expect(platform.sent("PUT", LISTING("chrome"))).toHaveLength(1);
    expect(chrome.value.stores.chrome.appStoreConnect).toBeUndefined();
    expect(chrome.value.sayToPerson).toBeUndefined();
  });

  it("refuses a screenshot outside projectPath and one approval for two stores before sending anything", async () => {
    const outside = path.join(os.tmpdir(), `extdev-outside-${Date.now()}.png`);
    fs.writeFileSync(outside, png(1280, 800));

    const escaped = JSON.parse(
      await submit({
        action: "sync-listing",
        browsers: ["chrome"],
        projectPath: root,
        screenshots: [outside],
        api: API,
      }),
    );
    const two = JSON.parse(
      await submit({
        action: "sync-listing",
        browsers: ["chrome", "firefox"],
        projectPath: root,
        approvalId: "apr_x",
        api: API,
      }),
    );
    const noPath = JSON.parse(
      await submit({ action: "sync-listing", browsers: ["chrome"], api: API }),
    );

    expect(escaped.status).toBe("bad-request");
    expect(two.status).toBe("bad-request");
    expect(noPath.status).toBe("bad-request");
    expect(platform.calls).toHaveLength(0);
  });

  it("says which failing listing checks STORE.md and the built icon already cover", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({
      body: {
        summary: { canSubmit: false },
        checks: [
          { id: "listing.title_present", status: "fail" },
          { id: "listing.chrome_description_present", status: "fail" },
          { id: "listing.chrome_icon_present", status: "fail" },
          { id: "listing.chrome_screenshots_present", status: "fail" },
          { id: "listing.privacy_policy_present", status: "warn" },
        ],
      },
    });

    const out = JSON.parse(
      await submit({
        action: "preflight",
        browsers: ["chrome"],
        projectPath: root,
        api: API,
      }),
    );
    const advisory = out.value.stores.chrome.storeMd;

    expect(advisory.covers).toEqual([
      "title found in STORE.md, not yet in the console listing",
      "description found in STORE.md, not yet in the console listing",
      "icon 128 px found in dist/chrome/icons/128.png, not yet in the listing",
    ]);

    expect(advisory.notCovered.join("\n")).toContain("screenshots");
    expect(
      advisory.notCovered.find((line: string) =>
        line.startsWith("privacy policy URL"),
      ),
    ).toBe(
      "privacy policy URL: not in STORE.md; add `- Privacy policy URL: <address>` under `## Privacy and data use`",
    );

    expect(out.hint).toContain('action:"sync-listing"');
  });

  it("names the policy URL STORE.md carries on the covers line and on the platform's privacy warning", async () => {
    if (process.platform === "win32") return;

    const root = project();
    fs.writeFileSync(
      path.join(root, "STORE.md"),
      STORE_MD.replace(
        "- Privacy policy URL: TODO. Not strictly required.",
        "- Privacy policy URL: https://example.com/privacy",
      ),
    );

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({
      body: {
        summary: { canSubmit: true },
        checks: [
          {
            id: "listing.privacy_policy_present",
            status: "warn",
            message:
              "privacy policy URL: not set; add `- Privacy policy URL: <address>` under `## Privacy and data use` in STORE.md.",
          },
          { id: "listing.title_present", status: "pass" },
        ],
      },
    });

    const out = JSON.parse(
      await submit({
        action: "preflight",
        browsers: ["chrome"],
        projectPath: root,
        api: API,
      }),
    );
    const chrome = out.value.stores.chrome;

    expect(chrome.storeMd.covers).toContain(
      "privacy policy URL found in STORE.md (https://example.com/privacy), not yet in the console listing; sync-listing writes it",
    );

    expect(
      chrome.storeMd.notCovered.some((line: string) =>
        line.startsWith("privacy policy URL"),
      ),
    ).toBe(false);

    expect(chrome.warnings[0].message).toBe(
      "privacy policy URL found in STORE.md (https://example.com/privacy), not yet in the console listing; sync-listing writes it.",
    );

    expect(chrome.warnings[0].message).not.toContain(
      "add `- Privacy policy URL",
    );

    expect(JSON.stringify(out)).not.toMatch(/attested|hosted|PRIVACY\.md/);
  });

  it("keeps the platform's privacy instruction as it is when STORE.md does not carry the URL", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({
      body: {
        summary: { canSubmit: true },
        checks: [
          {
            id: "listing.privacy_policy_present",
            status: "warn",
            message:
              "privacy policy URL: not set; add `- Privacy policy URL: <address>` under `## Privacy and data use` in STORE.md.",
          },
        ],
      },
    });

    const out = JSON.parse(
      await submit({
        action: "preflight",
        browsers: ["chrome"],
        projectPath: root,
        api: API,
      }),
    );
    const chrome = out.value.stores.chrome;

    expect(chrome.warnings[0].message).toBe(
      "privacy policy URL: not set; add `- Privacy policy URL: <address>` under `## Privacy and data use` in STORE.md.",
    );

    expect(chrome.warnings[0].message).not.toContain("STORE.md carries");
    expect(chrome.storeMd.covers).toEqual([]);
  });

  it("names the line shape it takes when STORE.md has the line and the reader could not take it", async () => {
    if (process.platform === "win32") return;

    const root = project();
    fs.writeFileSync(
      path.join(root, "STORE.md"),
      STORE_MD.replace(
        "- Category: Productivity (Chrome Web Store), Privacy & Security (Firefox and\n  Edge).",
        [
          "- Category: Productivity (Chrome Web Store), Tools (Edge)",
          "- Support email: help at example dot com",
        ].join("\n"),
      ),
    );

    platform.login();
    platform.routes[`POST ${PREFLIGHT("firefox")}`] = () => ({
      body: {
        summary: { canSubmit: false },
        checks: [
          {
            id: "listing.firefox_categories_present",
            status: "fail",
            message: "Add a category to STORE.md.",
          },
          {
            id: "listing.firefox_support_email_present",
            status: "warn",
            message: "Add a support email to STORE.md.",
          },
          {
            id: "listing.firefox_license_present",
            status: "fail",
            message: "Add a license to STORE.md.",
          },
        ],
      },
    });

    const out = JSON.parse(
      await submit({
        action: "preflight",
        browsers: ["firefox"],
        projectPath: root,
        api: API,
      }),
    );
    const firefox = out.value.stores.firefox;
    const category =
      "category: the `- Category:` line in STORE.md names chrome and edge only; the reader takes `- Category: <name>` for every store, or `- Category: <name> (Chrome), <name> (Firefox)` per store";
    const email =
      "support email: the `- Support email:` line in STORE.md is not an email address; the reader takes `- Support email: <address>`";

    expect(firefox.storeMd.notCovered).toEqual([
      category,
      email,
      "license: not in STORE.md",
    ]);

    expect(firefox.failing.map((check: { message?: string }) => check.message)).toEqual([
      `${category}.`,
      "Add a license to STORE.md.",
    ]);

    expect(firefox.warnings[0].message).toBe(`${email}.`);
    expect(firefox.storeMd.skipped).toEqual([
      "supportEmail in STORE.md is not an email address, so it was left out",
    ]);
  });

  it("replaces a failing check's fix text with the coverage fact when STORE.md or the built icon carries the value", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({
      body: {
        summary: { canSubmit: false },
        checks: [
          {
            id: "listing.title_present",
            status: "fail",
            message: "Set a title for the store listing.",
          },
          {
            id: "listing.chrome_icon_present",
            status: "fail",
            expected: "At least 1 icon",
            actual: "0 icons",
          },
          {
            id: "listing.chrome_screenshots_present",
            status: "fail",
            expected: "At least 1 screenshot",
            actual: "0 screenshots",
          },
        ],
      },
    });

    const out = JSON.parse(
      await submit({
        action: "preflight",
        browsers: ["chrome"],
        projectPath: root,
        api: API,
      }),
    );
    const failing = out.value.stores.chrome.failing;

    expect(failing.map((check: { message?: string }) => check.message)).toEqual(
      [
        "title found in STORE.md, not yet in the console listing; sync-listing writes it.",
        "icon 128 px found in dist/chrome/icons/128.png, not yet in the listing; sync-listing writes it.",
        undefined,
      ],
    );

    expect(failing[1]).toMatchObject({
      expected: "At least 1 icon",
      actual: "0 icons",
    });
  });

  it("names what STORE.md carries that the listing already has, apart from what still needs a sync", async () => {
    if (process.platform === "win32") return;

    const root = project();
    fs.writeFileSync(
      path.join(root, "STORE.md"),
      [
        "# Store metadata",
        "",
        "## Listing",
        "",
        "- Title: Rebeccat",
        "",
        "## Privacy and data use",
        "",
        "- Privacy policy URL: https://example.com/privacy",
        "",
      ].join("\n"),
    );

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({
      body: {
        summary: { canSubmit: true },
        checks: [
          { id: "listing.privacy_policy_present", status: "pass" },
          { id: "listing.title_present", status: "pass" },
          { id: "listing.chrome_description_present", status: "fail" },
        ],
      },
    });

    const out = JSON.parse(
      await submit({
        action: "preflight",
        browsers: ["chrome"],
        projectPath: root,
        api: API,
      }),
    );
    const advisory = out.value.stores.chrome.storeMd;

    expect(advisory.onListing).toEqual([
      "privacy policy URL: STORE.md carries https://example.com/privacy, already on the listing",
      "title: STORE.md carries it, already on the listing",
    ]);

    expect(advisory.covers).toEqual([]);
    expect(advisory.notCovered).toEqual(["description: not in STORE.md"]);
  });
});

describe("extension_submit sync-listing sends the fields the platform hashes when the digests differ", () => {
  const platform = useProjectRoutes("extdev-sync-listing-digest-");
  const ACTION = "extension_store.listing";
  const LEGACY_SAFARI = ["title", "shortDescription", "fullDescription", "categories", "supportEmail", "privacyPolicyUrl", "homepageUrl"];
  const SUBMISSIONS = "http://console.extension.localhost/acme/widget/submissions/safari";
  let root = "";

  beforeEach(() => {
    root = project();
    fs.appendFileSync(
      path.join(root, "STORE.md"),
      "\n## Safari\n\n- Subtitle: Blur names on screen\n- Search terms: privacy, redact\n- Review contact phone: +5511999999999\n",
    );
  });

  type Body = Parameters<typeof digestOf>[0];

  const hashedBy = (known: string[], body: Body) => {
    const scope = {
      store: "safari",
      listingDigest: digestOf({ ...body, listing: Object.fromEntries(Object.entries(body.listing).filter(([field]) => known.includes(field))) }),
    };

    return { scope, fingerprint: actionFingerprint(ACTION, scope) };
  };

  const platformHashing = (known: string[], digest?: Record<string, unknown>) => {
    let approved = "";

    platform.routes[`POST ${APPROVALS}`] = (call) => {
      approved = String(call.body.fingerprint);

      return { status: 201, body: { approvalId: "apr_d", approvalUrl: `${API}/device/approve/apr_d`, changes: ['title: "" -> "PII Shield"'] } };
    };

    platform.routes[`PUT ${LISTING("safari")}`] = (call) => {
      const { scope, fingerprint } = hashedBy(known, call.body);

      if (call.body.approvalId) {
        return fingerprint === approved
          ? { body: { ok: true, store: "safari", changes: ['title: "" -> "PII Shield"'] } }
          : { status: 409, body: { code: "APPROVAL_SCOPE_MISMATCH", message: "The approval is for another change.", ...(digest ? { digest } : {}) } };
      }

      return {
        status: 403,
        body: { code: "APPROVAL_REQUIRED", message: "Needs approval.", approvalRequest: { action: ACTION, scope, fingerprint }, ...(digest ? { digest } : {}) },
      };
    };

    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({ body: { checks: [] } });
  };

  const sync = (extra: Record<string, unknown> = {}) =>
    submit({ action: "sync-listing", browsers: ["safari"], projectPath: root, api: API, ...extra });

  it("refuses without a retry when the platform names no digest", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platformHashing([...LEGACY_SAFARI, "searchTerms"]);

    const refused = JSON.parse(await sync());

    expect(platform.sent("PUT", LISTING("safari"))).toHaveLength(1);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(refused.status).toBe("sync-listing-refused");
    expect(refused.value.stores.safari).toEqual({
      store: "safari",
      status: "refused",
      code: "LISTING_DIGEST_MISMATCH",
      message: "The platform did not name the fields it hashes; update the platform or this server.",
      trackUrl: SUBMISSIONS,
      filled: ["title", "subtitle", "shortDescription", "fullDescription", "searchTerms", "reviewContactPhone", "icons"],
    });

    expect(refused.value.sayToPerson).toBe("The platform did not name the fields it hashes; update the platform or this server.");
    expect(refused.error.message).toContain("did not name the fields it hashes");

    platform.calls.length = 0;

    const withId = JSON.parse(await sync({ approvalId: "apr_d" }));

    expect(platform.sent("PUT", LISTING("safari"))).toHaveLength(1);
    expect(withId.status).toBe("approval-rejected");
    expect(withId.error.platformCode).toBe("APPROVAL_SCOPE_MISMATCH");
  });

  it("retries with the set a newer platform names in digest.platform", async () => {
    if (process.platform === "win32") return;

    platform.login();

    const known = [...LEGACY_SAFARI, "subtitle"];
    platformHashing(known, { platform: known, client: [], differ: [] });

    const asked = JSON.parse(await sync());
    const puts = platform.sent("PUT", LISTING("safari"));

    expect(puts).toHaveLength(2);
    expect(Object.keys(puts[1]!.body.listing)).toEqual(["title", "subtitle", "shortDescription", "fullDescription"]);
    expect(asked.status).toBe("approval-required");
    expect(asked.value.stores.safari.digest).toEqual({
      client: ["title", "subtitle", "shortDescription", "fullDescription", "categories", "searchTerms", "supportEmail", "privacyPolicyUrl", "homepageUrl", "reviewContactPhone"],
      platform: known,
      differ: ["searchTerms", "reviewContactPhone"],
    });

    expect(asked.value.stores.safari.deferred).toEqual(["searchTerms", "reviewContactPhone"]);
    expect(asked.value.stores.safari.filled).toEqual(["title", "subtitle", "shortDescription", "fullDescription", "icons"]);
    expect(asked.value.sayToPerson).toBe(
      "The platform does not take searchTerms and reviewContactPhone yet (its build is behind this server); the other 4 fields are in the approval. Say sync-listing again after the platform updates.",
    );

    platform.calls.length = 0;

    const written = JSON.parse(await sync({ approvalId: "apr_d" }));
    const withId = platform.sent("PUT", LISTING("safari"));

    expect(withId).toHaveLength(1);
    expect(Object.keys(withId[0]!.body.listing)).toContain("searchTerms");
    expect(withId[0]!.body.approvalId).toBe("apr_d");
    expect(written.status).toBe("listing-synced");
    expect(written.value.stores.safari).toEqual({
      store: "safari",
      status: "synced",
      changes: ['title: "" -> "PII Shield"'],
      filled: ["title", "subtitle", "shortDescription", "fullDescription", "searchTerms", "reviewContactPhone", "icons"],
      stillBlocking: [],
    });

    expect(written.value.sayToPerson).toBeUndefined();
    expect(written.value.links[0].url).toBeTruthy();
  });

  it("never retries nor defers when the platform hashes every field this server declares", async () => {
    if (process.platform === "win32") return;

    platform.login();

    const all = [...LEGACY_SAFARI, "subtitle", "searchTerms", "reviewContactPhone"];
    platformHashing(all, { platform: all, client: all, differ: [] });

    const asked = JSON.parse(await sync());

    expect(platform.sent("PUT", LISTING("safari"))).toHaveLength(1);
    expect(asked.status).toBe("approval-required");
    expect(asked.value.stores.safari.digest).toBeUndefined();
    expect(asked.value.stores.safari.deferred).toBeUndefined();
    expect(asked.value.stores.safari.filled).toEqual(["title", "subtitle", "shortDescription", "fullDescription", "searchTerms", "reviewContactPhone", "icons"]);
    expect(asked.value.sayToPerson).toBeUndefined();

    platform.calls.length = 0;

    const written = JSON.parse(await sync({ approvalId: "apr_d" }));

    expect(platform.sent("PUT", LISTING("safari"))).toHaveLength(1);
    expect(written.status).toBe("listing-synced");
    expect(written.value.stores.safari.deferred).toBeUndefined();
  });

  it("answers a second mismatch with the digest and which side is behind", async () => {
    if (process.platform === "win32") return;

    platform.login();

    const digest = {
      client: ["title", "subtitle", "shortDescription", "fullDescription", "categories", "searchTerms", "supportEmail", "privacyPolicyUrl", "homepageUrl", "reviewContactPhone"],
      platform: LEGACY_SAFARI,
      differ: ["subtitle", "searchTerms", "reviewContactPhone"],
    };

    platform.routes[`PUT ${LISTING("safari")}`] = () => ({
      status: 403,
      body: { code: "APPROVAL_REQUIRED", message: "Needs approval.", approvalRequest: { action: ACTION, scope: { store: "safari", listingDigest: "0".repeat(64) }, fingerprint: "f".repeat(64) }, digest },
    });

    const refused = JSON.parse(await sync());

    expect(platform.sent("PUT", LISTING("safari"))).toHaveLength(2);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(refused.status).toBe("sync-listing-refused");
    expect(refused.value.stores.safari).toEqual({
      store: "safari",
      status: "refused",
      code: "LISTING_DIGEST_MISMATCH",
      message:
        "The platform hashes this listing differently from this server even after leaving out subtitle, searchTerms and reviewContactPhone: this server declares subtitle, searchTerms and reviewContactPhone, which the platform does not hash, so this server is newer than the platform's build. No approval was requested. Say sync-listing again after the platform updates.",
      digest,
      trackUrl: SUBMISSIONS,
      filled: ["title", "subtitle", "shortDescription", "fullDescription", "searchTerms", "reviewContactPhone", "icons"],
    });

    expect(refused.value.sayToPerson).toBe(refused.value.stores.safari.message);
    expect(refused.error.message).toContain("this server is newer than the platform's build");

    platform.calls.length = 0;
    platform.routes[`PUT ${LISTING("safari")}`] = () => ({
      status: 403,
      body: {
        code: "APPROVAL_REQUIRED",
        message: "Needs approval.",
        approvalRequest: { action: ACTION, scope: { store: "safari", listingDigest: "0".repeat(64) }, fingerprint: "f".repeat(64) },
        digest: { platform: [...digest.client, "ageRating"], client: digest.client, differ: ["ageRating"] },
      },
    });

    const behind = JSON.parse(await sync());

    expect(platform.sent("PUT", LISTING("safari"))).toHaveLength(1);
    expect(behind.value.stores.safari.digest).toEqual({ client: digest.client, platform: [...digest.client, "ageRating"], differ: ["ageRating"] });
    expect(behind.value.stores.safari.message).toBe(
      "The platform hashes this listing differently from this server: the platform hashes ageRating, which this server does not know, so the platform is newer than this server. No approval was requested. Update this server to the latest release, then say sync-listing again.",
    );
  });

  it("leaves chrome, edge and firefox at one send and names the digest on their mismatch", async () => {
    if (process.platform === "win32") return;

    platform.login();

    for (const store of ["chrome", "edge", "firefox"] as const) {
      platform.calls.length = 0;
      platform.routes[`PUT ${LISTING(store)}`] = () => ({
        status: 403,
        body: {
          code: "APPROVAL_REQUIRED",
          message: "Needs approval.",
          approvalRequest: { action: ACTION, scope: { store, listingDigest: "0".repeat(64) }, fingerprint: "f".repeat(64) },
          digest: { platform: STORE_FIELDS[store], client: STORE_FIELDS[store], differ: [] },
        },
      });

      const refused = JSON.parse(await submit({ action: "sync-listing", browsers: [store], projectPath: root, api: API }));

      expect(platform.sent("PUT", LISTING(store))).toHaveLength(1);
      expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
      expect(refused.status).toBe("sync-listing-refused");
      expect(refused.value.stores[store].code).toBe("LISTING_DIGEST_MISMATCH");
      expect(refused.value.stores[store].digest.differ).toEqual([]);
      expect(refused.value.stores[store].digest.client).toEqual(refused.value.stores[store].digest.platform);
      expect(refused.value.stores[store].deferred).toBeUndefined();
      expect(refused.value.stores[store].message).toContain("both declare the same fields and still disagree on the hash, so the platform is newer than this server");
    }
  });
});

function digestOf(body: {
  listing: Record<string, unknown>;
  media?: {
    icons?: Array<{ dataBase64: string }>;
    screenshots?: Array<{ dataBase64: string }>;
  };
}): string {
  const image = (item: { dataBase64: string }) => {
    const bytes = Buffer.from(item.dataBase64, "base64");

    return {
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      bytes,
      source: "",
    };
  };

  return listingDigest({
    listing: body.listing,
    ...(body.media?.icons ? { icons: body.media.icons.map(image) } : {}),
    ...(body.media?.screenshots
      ? { screenshots: body.media.screenshots.map(image) }
      : {}),
});
}
