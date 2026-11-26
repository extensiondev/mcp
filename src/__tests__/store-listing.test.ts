import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { CHROMEWEBSTORE_MD_PREFILL_CALL, parseChromeWebStoreMd } from "../lib/chromewebstore-md";
import { stripHtmlComments } from "../lib/html-comments";
import { parseStoreMd } from "../lib/store-md";
import { emailShaped } from "../lib/store-md-bounded";
import { listingDigest, writeBody } from "../lib/store-listing-media";
import { STORE_FIELDS, derivedListingFields, listingForStore, parseStoreMdListing } from "../lib/store-md-listing";
import { TOOL_POLICY } from "../lib/tool-policy";
import { readLocalListing } from "../lib/submit-facts-local";
import { digestOf } from "./fixtures/listing-digest";
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

- Category: Tools (Chrome Web Store), Privacy & Security (Firefox and
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

const SAFARI_UNREAD = [
  { field: "subtitle", line: "- Subtitle:", section: "## Listing" },
  { field: "searchTerms", line: "- Search terms:", section: "## Listing" },
  { field: "supportEmail", line: "- Support email:", section: "## Listing" },
  { field: "privacyPolicyUrl", line: "- Privacy policy URL:", section: "## Privacy and data use" },
  { field: "homepageUrl", line: "- Homepage:", section: "## Listing" },
  { field: "reviewerNotes", line: "### Reviewer notes", section: "## Safari" },
  { field: "reviewContactName", line: "- Review contact name:", section: "## Safari" },
  { field: "reviewContactEmail", line: "- Review contact email:", section: "## Safari" },
  { field: "reviewContactPhone", line: "- Review contact phone:", section: "## Safari" },
  { field: "supportUrl", line: "- Support URL:", section: "## Listing" },
  { field: "releaseMode", line: "- Release:", section: "## Safari" },
];

const SAFARI_SECTION_UNREAD = SAFARI_UNREAD.filter((row) => !["subtitle", "searchTerms", "reviewContactPhone"].includes(row.field));

const SCREENSHOTS_SKIPPED = 'the `- Screenshots:` line in STORE.md names no screenshot file; capture them with extension_screenshot store:"<store>", one call per view, and sync-listing picks them up from store/screenshots/<store>/';

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
  it("897: leaves no comment behind when removing one closes another, in linear time", () => {
    expect(stripHtmlComments("a<!-- one -->b<!--\ntwo\n-->c")).toBe("abc");
    expect(stripHtmlComments("a<!-<!-- inner -->- hidden -->b")).toBe("ab");
    expect(stripHtmlComments("a<!-- never closed")).toBe("a<!-- never closed");
    expect(stripHtmlComments("a --> b")).toBe("a --> b");
    expect(parseStoreMd("## Firefox\n\n### Reviewer notes\n\nSign in first.<!-<!-- x -->- test account: hidden -->\n").firefox?.approvalNotes).toBe("Sign in first.");

    const started = performance.now();

    expect(stripHtmlComments("<!--".repeat(100_000))).toHaveLength(400_000);
    expect(stripHtmlComments("<!-".repeat(50_000) + "<!-- x -->" + "- y -->".repeat(50_000))).toBe("");
    expect(emailShaped(`!@!.${"!.".repeat(50_000)}@`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(400);
  });

  it("897: reads a CHROMEWEBSTORE.md heading by the same rule as before, in linear time", () => {
    const table = "\n\n| Permission | Justification |\n| --- | --- |\n| tabs | Reads the open tabs. |\n";
    const headingOf = (line: string) => parseChromeWebStoreMd(`${line}${table}`).headings.permissionJustifications ?? null;

    for (const line of ["## Permission justifications", "##\tPermission justifications  ", "##   Permissions Justification", "## \r Permission justifications", "##Permission justifications", "# Permission justifications", "## Permission justifications\r", "## Permission\rjustifications"]) {
      const before = /^##\s+(.+)$/.exec(line)?.[1]?.trim();

      expect(headingOf(line), JSON.stringify(line)).toBe(before !== undefined && /^permissions? justifications?$/i.test(before) ? `## ${before}` : null);
    }

    expect(headingOf("## Permission justifications")).toBe("## Permission justifications");
    expect(headingOf("##Permission justifications")).toBeNull();

    const started = performance.now();

    expect(parseChromeWebStoreMd(`##${" ".repeat(200_000)}\r${table}`).headings).toEqual({});
    expect(parseChromeWebStoreMd(`${`##${" ".repeat(2_000)}\r\n`.repeat(200)}${table}`).headings).toEqual({});
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("897: reads an email address by the same rule as before", () => {
    for (const [value, shaped] of [["a@b.co", true], ["first.last@mail.example.org", true], ["a@.b.c", true], ["a@b", false], ["a@b.", false], ["a@.b", false], ["@b.co", false], ["a@b@c.co", false], ["a b@c.co", false], ["", false]] as const) {
      expect(emailShaped(value), value).toBe(shaped);
      expect(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), value).toBe(shaped);
    }
  });

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
      categories: ["Tools"],
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

  it("takes localized copy that opens with the word todo and names a TODO or TBD line it left out", () => {
    const store = (description: string, summary: string) =>
      ["## Listing", "", `- Summary: ${summary}`, "- Description:", `  ${description}`, ""].join("\n");
    const pt = listingForStore(parseStoreMdListing(store("Todo jogo conta. Acompanhe o placar ao vivo.", "Toda partida no navegador.")), "firefox");
    const es = listingForStore(parseStoreMdListing(store("Todo lo que pasa en el partido.", "TBD")), "firefox");

    expect(pt.listing).toMatchObject({ fullDescription: "Todo jogo conta. Acompanhe o placar ao vivo.", shortDescription: "Toda partida no navegador." });
    expect(pt.unread).toEqual({});
    expect(es.listing.fullDescription).toBe("Todo lo que pasa en el partido.");
    expect(es.listing.shortDescription).toBeUndefined();
    expect(es.unread.shortDescription).toEqual({ line: "- Summary:", reason: "starts with the placeholder word TODO or TBD" });
    expect(es.skipped).toContain("shortDescription in STORE.md starts with the placeholder word TODO or TBD, so it was left out");
    expect(listingForStore(parseStoreMdListing(store("TODO: write the description.", "TODOS os jogos.")), "firefox").listing).toEqual({ shortDescription: "TODOS os jogos." });
  });

  it("takes one category up to its store note for every store and keeps the note out", () => {
    const parsed = parseStoreMdListing(
      STORE_MD.replace(
        "- Category: Tools (Chrome Web Store), Privacy & Security (Firefox and\n  Edge).",
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
        "- Category: Tools (Chrome Web Store), Privacy & Security (Firefox and\n  Edge).",
        "- Category: Privacy & Security",
      ),
    );

    expect(listingForStore(parsed, "chrome").listing.categories).toEqual([
      "Privacy & Security",
    ]);

    expect(listingForStore(parsed, "edge").listing.categories).toEqual([
      "Privacy & Security",
    ]);
  });

  it("reads a Privacy policy URL line under Listing or a store section, and lets the privacy section win", () => {
    const underListing = parseStoreMdListing(
      STORE_MD.replace("- Screenshots:", "- Privacy policy URL: https://example.com/privacy.\n- Screenshots:"),
    );

    expect(listingForStore(underListing, "chrome").listing.privacyPolicyUrl).toBe("https://example.com/privacy");
    expect(underListing.lines.privacyPolicyUrl).toBe("Privacy policy URL");

    const both = parseStoreMdListing(
      STORE_MD.replace("- Screenshots:", "- Privacy policy URL: https://example.com/listing\n- Screenshots:").replace(
        "- Privacy policy URL: TODO. Not strictly required.",
        "- Privacy policy URL: https://example.com/privacy",
      ),
    );

    expect(listingForStore(both, "firefox").listing.privacyPolicyUrl).toBe("https://example.com/privacy");

    const own = parseStoreMdListing(`${STORE_MD}\n## Safari\n\n- Privacy policy URL: https://example.com/safari-privacy\n`);

    expect(listingForStore(own, "safari").listing.privacyPolicyUrl).toBe("https://example.com/safari-privacy");
    expect(listingForStore(own, "chrome").listing.privacyPolicyUrl).toBeUndefined();
  });

  it("reads a single-value line up to its store note and takes the per-store values the note gives", () => {
    const parsed = parseStoreMdListing(
      STORE_MD.replace(
        "- Category: Tools (Chrome Web Store), Privacy & Security (Firefox and\n  Edge).",
        [
          "- Name: PII Shield (Safari: PII Shield for Safari, Edge: PII Shield for Edge)",
          "- Summary: Hide personal information on every open tab (beta)",
          "- Category: Productivity (Chrome: Tools, Safari: Utilities)",
        ].join("\n"),
      ),
    );
    const chrome = listingForStore(parsed, "chrome").listing;
    const safari = listingForStore(parsed, "safari").listing;
    const edge = listingForStore(parsed, "edge").listing;

    expect(chrome).toMatchObject({ title: "PII Shield", shortDescription: "Hide personal information on every open tab (beta)", categories: ["Tools"] });
    expect(listingForStore(parsed, "firefox").listing.categories).toEqual(["Productivity"]);
    expect(safari).toMatchObject({ title: "PII Shield for Safari", categories: ["Utilities"] });
    expect(edge).toMatchObject({ title: "PII Shield for Edge", categories: ["Productivity"] });
    expect(listingForStore(parsed, "safari").unread).toEqual({});

    const several = parseStoreMdListing(
      STORE_MD.replace(
        "- Category: Tools (Chrome Web Store), Privacy & Security (Firefox and\n  Edge).",
        "- Category: Tools (Chrome Web Store), Privacy & Security (Firefox: Privacy & Security, Edge)",
      ),
    );

    expect(listingForStore(several, "chrome").listing.categories).toEqual(["Tools"]);
    expect(listingForStore(several, "firefox").listing.categories).toEqual(["Privacy & Security"]);
    expect(listingForStore(several, "edge").listing.categories).toEqual(["Privacy & Security"]);
    expect(listingForStore(several, "safari").unread.categories).toEqual({ line: "- Category:", reason: "names chrome, edge and firefox only" });

    const own = parseStoreMdListing(`${STORE_MD.replace(/- Name: .*\n/, "- Name: PII Shield (Safari: PII Shield for Safari)\n")}\n## Safari\n\n- Name: Shield (Chrome: Not read here)\n`);

    expect(listingForStore(own, "safari").listing.title).toBe("Shield");
    expect(listingForStore(own, "chrome").listing.title).toBe("PII Shield");
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
        "- Category: Tools (Chrome Web Store), Privacy & Security (Firefox and\n  Edge).",
        [
          "- Category: Tools (Chrome Web Store), Tools (Edge)",
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
    expect(long.skipped).toEqual([]);
    expect(long.overLimit).toEqual([
      { field: "subtitle", length: 37, limit: 30, unit: "characters" },
      { field: "searchTerms", length: 121, limit: 100, unit: "characters" },
    ]);

    expect(long.unread.subtitle).toEqual({ line: "- Subtitle:", reason: "is 37 characters, over the 30 the listing takes" });
    expect(listingForStore(withLines("Blur names", "privacy"), "edge").skipped).toEqual([]);
  });

  it("leaves a value out of each store whose own limit it passes, and keeps it for the stores that take it", () => {
    const parsed = parseStoreMdListing(
      STORE_MD.replace("  are blurred on every open tab.", `  ${"a".repeat(4_500)}`).replace(
        "TODO user-facing notes.",
        "b".repeat(3_001),
      ),
    );

    const length = listingForStore(parsed, "chrome").listing.fullDescription?.length ?? 0;

    expect(length).toBeGreaterThan(4_500);
    expect(listingForStore(parsed, "edge").listing.fullDescription).toHaveLength(length);

    const safari = listingForStore(parsed, "safari");
    const firefox = listingForStore(parsed, "firefox");

    expect(safari.listing).not.toHaveProperty("fullDescription");
    expect(safari.unread.fullDescription?.reason).toBe(`is ${length} characters, over the 4000 characters the App Store takes`);
    expect(firefox.listing.fullDescription).toHaveLength(length);
    expect(firefox.listing).not.toHaveProperty("releaseNotes");
    expect(firefox.skipped).toEqual([]);
    expect(firefox.overLimit).toEqual([{ field: "releaseNotes", length: 3_001, limit: 3_000, unit: "characters" }]);
    expect(firefox.unread.releaseNotes).toEqual({ line: "### Release notes", reason: "is 3001 characters, over the 3000 characters Firefox Add-ons takes" });
  });

  it("names the App Store subtitle the platform derives from a short Summary, and nothing when the Summary is long or a Subtitle line exists", () => {
    const summary = (text: string) => listingForStore(parseStoreMdListing(STORE_MD.replace(/- Summary: .*\n/, `- Summary: ${text}\n`)), "safari");
    const long = "Blur names, emails, phone numbers and card numbers on every open tab with one click, before you share it all.";
    const short = "Blur personal data on a page";

    expect(long).toHaveLength(109);
    expect(short).toHaveLength(28);
    expect(summary(long).listing).not.toHaveProperty("subtitle");
    expect(derivedListingFields("safari", summary(long).listing)).toEqual([]);
    expect(summary(short).listing).not.toHaveProperty("subtitle");
    expect(derivedListingFields("safari", summary(short).listing)).toEqual([
      { field: "subtitle", from: "shortDescription", line: "Summary", value: short },
    ]);

    expect(derivedListingFields("chrome", summary(short).listing)).toEqual([]);

    const own = listingForStore(
      parseStoreMdListing(STORE_MD.replace("- Screenshots:", `- Subtitle: Blur names on screen\n- Screenshots:`).replace(/- Summary: .*\n/, `- Summary: ${short}\n`)),
      "safari",
    );

    expect(own.listing.subtitle).toBe("Blur names on screen");
    expect(derivedListingFields("safari", own.listing)).toEqual([]);
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

  it("reads the review contact name, email and reviewer notes under the Safari section, for the App Store only, and refuses an email that is not one", () => {
    const withContact = (email: string) =>
      parseStoreMdListing(
        `${STORE_MD}\n## Safari\n\n- Review contact name: Cezar Augusto\n- Review contact email: ${email}\n- Review contact phone: +5511999999999\n\n### Reviewer notes\n\nTurn Rebeccat on in Safari Settings, then click the toolbar button.\n`,
      );
    const safari = listingForStore(withContact("review@example.com"), "safari");

    expect(safari.listing).toMatchObject({
      reviewContactName: "Cezar Augusto",
      reviewContactEmail: "review@example.com",
      reviewContactPhone: "+5511999999999",
      reviewerNotes: "Turn Rebeccat on in Safari Settings, then click the toolbar button.",
    });

    expect(safari.skipped).toEqual([]);

    const chrome = listingForStore(withContact("review@example.com"), "chrome").listing;
    expect(chrome).not.toHaveProperty("reviewContactName");
    expect(chrome).not.toHaveProperty("reviewContactEmail");
    expect(chrome).not.toHaveProperty("reviewerNotes");

    const odd = listingForStore(withContact("review at example dot com"), "safari");
    expect(odd.listing).not.toHaveProperty("reviewContactEmail");
    expect(odd.listing.reviewContactName).toBe("Cezar Augusto");
    expect(odd.unread.reviewContactEmail).toEqual({ line: "- Review contact email:", reason: "is not an email address" });
  });

  it("records a Screenshots line by its key, in the bare form and with a note, and reads no file from it", () => {
    const walk = parseStoreMdListing(
      STORE_MD.replace(
        "- Screenshots: TODO at least one 1280x800 screenshot per store.",
        "- Screenshots (1280x800, in this order):\n  1. store/screenshot-1.png\n  2. store/screenshot-2.png",
      ),
    );

    expect(walk.screenshotsLine).toBe("Screenshots (1280x800, in this order)");
    expect(walk).not.toHaveProperty("screenshots");
    expect(parseStoreMdListing(STORE_MD).screenshotsLine).toBe("Screenshots");
    expect(parseStoreMdListing(STORE_MD.replace("- Screenshots: TODO at least one 1280x800 screenshot per store.\n", "")).screenshotsLine).toBeUndefined();
    expect(listingForStore(walk, "chrome").listing.fullDescription).toContain("Detection happens on your computer.");
  });

  it("takes screenshots only from the argument and names a Screenshots line in STORE.md as skipped with the sync-listing door", () => {
    const root = project();
    fs.writeFileSync(
      path.join(root, "STORE.md"),
      STORE_MD.replace(
        "- Screenshots: TODO at least one 1280x800 screenshot per store.",
        "- Screenshots (1280x800, in this order):\n  1. shots/popup.png",
      ),
    );

    const local = readLocalListing(root, "chrome");
    if ("problem" in local) throw new Error(local.problem);

    expect(local.patch.screenshots).toBeUndefined();
    expect(local.skipped).toEqual([]);
    expect(local.screenshotsLine).toBe(
      'the `- Screenshots (1280x800, in this order):` line in STORE.md names 1 screenshot; sync-listing takes it as its screenshots argument, as PNG paths inside projectPath; extension_screenshot store:"<store>" writes them under store/screenshots/<store>/, which sync-listing reads on its own',
    );

    expect(local.lines.title).toBe("Name");

    const passed = readLocalListing(root, "chrome", [{ sha256: "b".repeat(64), width: 640, height: 400, bytes: png(640, 400), size: 1, source: "given.png" }]);
    if ("problem" in passed) throw new Error(passed.problem);

    expect(passed.patch.screenshots?.map((shot) => shot.source)).toEqual(["given.png"]);

    fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD.replace("- Screenshots: TODO at least one 1280x800 screenshot per store.\n", ""));

    const none = readLocalListing(root, "chrome");
    if ("problem" in none) throw new Error(none.problem);

    expect(none.skipped).toEqual([]);
    expect(none.patch.screenshots).toBeUndefined();
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

    expect(
      listingDigest({
        listing: { title: "PII Shield", reviewContactPhone: "+5511999999999", supportUrl: "https://example.com/support" },
      }),
    ).toBe("e660d01dee637ba0e15fc7a0f938f3ead7a8e6683239b9460649ee5af0a3b732");
  });
});

describe("the STORE.md Support URL line", () => {
  it("is read under ## Listing as the App Store's support URL and sent with the Safari listing only", () => {
    const parsed = parseStoreMdListing("## Listing\n\n- Name: Widget\n- Support URL: https://example.com/support\n- Homepage: https://example.com\n");

    expect(listingForStore(parsed, "safari").listing.supportUrl).toBe("https://example.com/support");
    expect(listingForStore(parsed, "safari").listing.homepageUrl).toBe("https://example.com");
    expect(listingForStore(parsed, "chrome").listing.supportUrl).toBeUndefined();
    expect(STORE_FIELDS.safari.slice(-2)).toEqual(["supportUrl", "releaseMode"]);
  });
});

describe("a STORE.md listing in more than one language", () => {
  const TRANSLATED = `${STORE_MD}
## Listing (pt_br)

- Name: PII Shield
- Summary: Esconda dados pessoais em todas as abas com um clique.
- Description:

  Vai compartilhar a tela? Clique no PII Shield.

## Listing (draft)

- Homepage: https://example.com
`;

  function localized(): string {
    const root = project();
    fs.writeFileSync(path.join(root, "STORE.md"), TRANSLATED);
    fs.mkdirSync(path.join(root, "src", "_locales", "en"), { recursive: true });
    fs.mkdirSync(path.join(root, "src", "_locales", "pt_BR"));
    fs.mkdirSync(path.join(root, "src", "_locales", "de"));
    fs.writeFileSync(path.join(root, "src", "manifest.json"), JSON.stringify({ name: "__MSG_appName__", description: "__MSG_appDesc__", default_locale: "en" }));
    fs.writeFileSync(path.join(root, "src", "_locales", "en", "messages.json"), JSON.stringify({ appName: { message: "PII Shield" }, appDesc: { message: "Hide personal information." } }));
    fs.writeFileSync(path.join(root, "src", "_locales", "pt_BR", "messages.json"), JSON.stringify({ appName: { message: "PII Shield BR" }, appDesc: { message: "Manifest words." } }));
    fs.writeFileSync(path.join(root, "src", "_locales", "de", "messages.json"), JSON.stringify({ appname: { message: "PII-Schild" }, appDesc: { message: "Persönliche Daten verbergen." } }));

    return root;
  }

  it("reads each language's section apart from the default listing", () => {
    const parsed = parseStoreMdListing(TRANSLATED);

    expect(parsed.shared.shortDescription).toBe("Hide personal information on every open tab with one click.");
    expect(parsed.shared.homepageUrl).toBe("https://example.com");
    expect(parsed.locales).toEqual({
      "pt-BR": {
        title: "PII Shield",
        shortDescription: "Esconda dados pessoais em todas as abas com um clique.",
        fullDescription: "Vai compartilhar a tela? Clique no PII Shield.",
      },
    });
  });

  it("sends the languages to Firefox Add-ons, defaults the rest from _locales, and names them for the stores that take none", () => {
    const root = localized();
    const firefox = readLocalListing(root, "firefox");
    const chrome = readLocalListing(root, "chrome");
    const edge = readLocalListing(root, "edge");
    if ("problem" in firefox || "problem" in chrome || "problem" in edge) throw new Error("no listing");


    expect(firefox.patch.locales).toEqual({
      "pt-BR": parseStoreMdListing(TRANSLATED).locales["pt-BR"],
      de: { title: "PII-Schild", shortDescription: "Persönliche Daten verbergen." },
    });

    expect(firefox.localized?.rows).toEqual([
      { locale: "pt-BR", fields: ["title", "shortDescription", "fullDescription"], from: "## Listing (pt-BR) in STORE.md" },
      { locale: "de", fields: ["title", "shortDescription"], from: "src/_locales/de/messages.json" },
    ]);

    expect(firefox.localized?.sent).toBe(true);
    expect((writeBody(firefox.patch).listing as Record<string, unknown>).locales).toEqual(firefox.patch.locales);

    for (const other of [chrome, edge]) {
      expect(other.patch.locales).toBeUndefined();
      expect(other.localized?.sent).toBe(false);
      expect(other.localized?.sentence).toContain("the pt-BR and de listings were not sent");
      expect(other.localized?.sentence).toContain("`src/_locales/de/messages.json`");
    }
  });

  it("names a translated line over its limit instead of sending it", () => {
    const long = TRANSLATED.replace("- Summary: Esconda", `- Summary: ${"x".repeat(260)} Esconda`);
    const read = listingForStore(parseStoreMdListing(long), "firefox");
    const root = project();
    fs.writeFileSync(path.join(root, "STORE.md"), long);
    const local = readLocalListing(root, "firefox");
    if ("problem" in local) throw new Error(local.problem);

    expect(read.listing.shortDescription).toBe("Hide personal information on every open tab with one click.");
    expect(local.patch.locales?.["pt-BR"]?.shortDescription).toBeUndefined();
    expect(local.localized?.skipped[0]).toMatch(/^Summary for pt-BR \(## Listing \(pt-BR\) in STORE\.md\) is \d+ characters, over the 250/);
  });

  it("hashes the languages after every other field, and a listing without one as before", () => {
    const listing = { title: "PII Shield", reviewContactPhone: "+5511999999999", supportUrl: "https://example.com/support" };

    expect(listingDigest({ listing, locales: {} })).toBe("e660d01dee637ba0e15fc7a0f938f3ead7a8e6683239b9460649ee5af0a3b732");
    expect(listingDigest({ listing: { title: "PII Shield" }, locales: { "pt-BR": { title: "PII Shield BR", shortDescription: "Esconda." } } })).toBe("15bfdea0de67f20afb204f6135e4b054fca2ea59a87ccb0c9858e1cf26db4c7e");
  });
});
