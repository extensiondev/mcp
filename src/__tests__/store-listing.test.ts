import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { listingDigest } from "../lib/store-listing-media";
import { listingForStore, parseStoreMdListing } from "../lib/store-md-listing";
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
      "privacy policy URL: not set; add `- Privacy policy URL: <address>` under `## Privacy and data use` in STORE.md. STORE.md carries https://example.com/privacy; sync-listing writes it to the listing.",
    );

    expect(JSON.stringify(out)).not.toMatch(/attested|hosted|PRIVACY\.md/);
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
