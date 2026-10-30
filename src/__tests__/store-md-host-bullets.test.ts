import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { bulletLine, storeOwnLinesBody } from "../lib/store-md-bullets";
import { CHROME_SYNC_CALL, reconcileChromeCheck, reconcileChromeRow } from "../lib/store-md-chrome-reconcile";
import { bulletNamesHost, namesNotInBullets, patternCovers, uncoveredNamesIn } from "../lib/store-md-host-justifications";
import { listingForStore, parseStoreMdListing } from "../lib/store-md-listing";
import { readLocalListing, type LocalListing } from "../tools/store-listing";

const HOST_REASON = "Asked for one site at a time when the user allows it; nothing at install.";

const HANDS_FREE = (hostBullet: string, visibility = "### Visibility\n\n- Visibility: unlisted\n") => `# Store metadata

## Listing

- Name: Hands-free
- Summary: Browse with your head and face.

## Chrome Web Store

### Single purpose

Control web pages hands-free with your head and face.

### Permissions justification

- sidePanel: The side panel is the extension's only interface.
- offscreen: Chrome lets a camera run with no window only in an offscreen document.
- storage: Remembers the settings on the device.
- tabs: Finds the tab the user is looking at.
- scripting: Injects the pointer overlay into the page the user is looking at.
${hostBullet}
- No content scripts are declared in the manifest; the overlay is registered at run time.

### Test instructions

1. Click the toolbar button to open the side panel.

${visibility}`;

const chrome = (storeMd: string) => listingForStore(parseStoreMdListing(storeMd), "chrome").listing;

function localOf(storeMd: string): LocalListing {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-host-bullets-"));
  fs.writeFileSync(path.join(root, "STORE.md"), storeMd);

  const local = readLocalListing(root, "chrome");
  if ("problem" in local) throw new Error(local.problem);

  return local;
}

describe("a justification bullet keyed by a host pattern (ledger 302)", () => {
  it("reads the key up to the first colon followed by a space, so a host pattern is a key", () => {
    expect(bulletLine(`- *://*/*: ${HOST_REASON}`)).toEqual({ key: "*://*/*", value: HOST_REASON });
    expect(bulletLine(`- https://*.example.com/*: ${HOST_REASON}`)).toEqual({ key: "https://*.example.com/*", value: HOST_REASON });
    expect(bulletLine("- Description:")).toEqual({ key: "Description", value: "" });
    expect(bulletLine("- Privacy policy URL: https://example.com/privacy")).toEqual({ key: "Privacy policy URL", value: "https://example.com/privacy" });
    expect(bulletLine("- Homepage:https://example.com")).toBeNull();
    expect(bulletLine("plain prose: not a bullet")).toBeNull();
  });

  it("strips the backticks or quotes an author wraps the pattern in", () => {
    expect(bulletLine(`- \`*://*/*\`: ${HOST_REASON}`)).toEqual({ key: "*://*/*", value: HOST_REASON });
    expect(bulletLine(`- "*://*/*": ${HOST_REASON}`)).toEqual({ key: "*://*/*", value: HOST_REASON });
  });

  it("parses the three forms the walk tried, and counts six bullets for the Hands-free section, the host one among them", () => {
    const keyed = chrome(HANDS_FREE(`- *://*/*: ${HOST_REASON}`)).permissionJustifications!;
    const wrapped = chrome(HANDS_FREE(`- \`*://*/*\`: ${HOST_REASON}`)).permissionJustifications!;
    const prosed = chrome(HANDS_FREE("- Optional host permission: `*://*/*`. Nothing at install; the side panel asks for one site at a time.")).permissionJustifications!;

    expect(keyed.map((entry) => entry.permission)).toEqual(["sidePanel", "offscreen", "storage", "tabs", "scripting", "*://*/*"]);
    expect(keyed[5]).toEqual({ permission: "*://*/*", justification: HOST_REASON });
    expect(wrapped).toHaveLength(6);
    expect(wrapped[5]!.permission).toBe("*://*/*");
    expect(prosed).toHaveLength(6);
    expect(prosed[5]!.permission).toBe("Optional host permission");

    for (const entries of [keyed, wrapped, prosed]) expect(bulletNamesHost("*://*/*", entries)).toBe(true);
  });

  it("takes a bullet whose key or reason names the pattern, exact after stripping or a glob that covers it", () => {
    expect(patternCovers("`*://*/*`", "*://*/*")).toBe(true);
    expect(patternCovers("*://*/*", "https://www.example.com/*")).toBe(true);
    expect(patternCovers("<all_urls>", "https://www.example.com/*")).toBe(true);
    expect(patternCovers("https://*.example.com/*", "https://www.example.com/*")).toBe(true);
    expect(patternCovers("https://*.example.com/*", "https://example.org/*")).toBe(false);
    expect(patternCovers("storage", "https://example.org/*")).toBe(false);

    const reason = [{ permission: "Host access", justification: "A content script declared for https://leon-blur.vercel.app/* only." }];

    expect(bulletNamesHost("https://leon-blur.vercel.app/*", reason)).toBe(true);
    expect(bulletNamesHost("https://example.org/*", reason)).toBe(false);
    expect(bulletNamesHost("*://*/*", [{ permission: "Optional host permission", justification: "Allow all sites when the user asks." }])).toBe(true);
    expect(bulletNamesHost("https://example.org/*", [{ permission: "Optional host permission", justification: "Allow all sites when the user asks." }])).toBe(false);
    expect(namesNotInBullets(["storage", "*://*/*"], [{ permission: "storage", justification: "Remembers settings." }])).toEqual(["*://*/*"]);
  });

  it("reads the names a platform sentence says no bullet covers, from a check message or a row's actual", () => {
    expect(uncoveredNamesIn("the production Chrome package of build 154767e reaches *://*/*, http://localhost:4322/*, which no bullet under `### Permissions justification` in STORE.md names. Add a reason for each.")).toEqual([
      "*://*/*",
      "http://localhost:4322/*",
    ]);

    expect(uncoveredNamesIn("the Chrome package of build 154767e requests tabs, which no bullet under `### Permissions justification` names")).toEqual(["tabs"]);
    expect(uncoveredNamesIn("STORE.md has no `### Permissions justification` bullets")).toEqual([]);
  });
});

describe("the store section's own lines are read under any sub-heading (ledger 303)", () => {
  it("reads `- Visibility:` under a `### Visibility` sub-heading of `## Chrome Web Store`, and at the top of the section", () => {
    expect(chrome(HANDS_FREE(`- *://*/*: ${HOST_REASON}`)).visibility).toBe("unlisted");
    expect(chrome(HANDS_FREE(`- *://*/*: ${HOST_REASON}`, "").replace("## Chrome Web Store\n", "## Chrome Web Store\n\n- Visibility: public\n")).visibility).toBe("public");
    expect(chrome(HANDS_FREE(`- *://*/*: ${HOST_REASON}`, "")).visibility).toBeUndefined();
  });

  it("leaves the `### Permissions justification` bullets out of the store's own lines", () => {
    const body = storeOwnLinesBody("\n- Visibility: unlisted\n\n### Permissions justification\n\n- name: Reads the name.\n\n### Visibility\n\n- Summary: For the store.\n");

    expect(body).toContain("- Visibility: unlisted");
    expect(body).toContain("- Summary: For the store.");
    expect(body).not.toContain("- name: Reads the name.");

    const listing = chrome(HANDS_FREE("- name: Reads the name."));

    expect(listing.title).toBe("Hands-free");
    expect(listing.permissionJustifications!.map((entry) => entry.permission)).toContain("name");
  });
});

const NO_BULLETS = "STORE.md has no `### Permissions justification` bullets";
const REQUESTS = "the Chrome package of build 154767e requests *://*/*, which no bullet under `### Permissions justification` names";
const VISIBILITY_MESSAGE =
  "A new Chrome item defaults to Public in the dashboard, and this project's intent is Unlisted (the least public default, since STORE.md has no `- Visibility:` line). Google's API does not answer visibility, so set and confirm it on the Distribution tab of the item's dashboard.";
const HOST_MESSAGE =
  "the production Chrome package of build 154767e reaches *://*/*, which no bullet under `### Permissions justification` in STORE.md names. Add a reason for each, then paste it on the Privacy tab.";

const row = (id: string, actual: string, status = "missing") => ({
  id,
  label: id,
  required: true,
  format: "",
  status: status as "missing" | "unknown",
  satisfiedBy: "store-dashboard",
  how: "",
  actual,
});

describe("a Chrome row or check about STORE.md says what the file holds before the first sync (ledger 303)", () => {
  const withHost = localOf(HANDS_FREE(`- *://*/*: ${HOST_REASON}`));
  const withoutHost = localOf(HANDS_FREE("- clipboardWrite: Puts the blurred image on the clipboard."));
  const empty = localOf("# Store metadata\n\n## Listing\n\n- Name: Bare\n\n## Chrome Web Store\n\n### Single purpose\n\nOne thing.\n");

  it("answers the permission justifications row as not synced yet with the bullet count, never as an empty file", () => {
    expect(reconcileChromeRow(row("chrome.permission_justifications", NO_BULLETS), withHost).actual).toBe(
      `not synced yet (STORE.md carries 6 bullets under \`### Permissions justification\`): run ${CHROME_SYNC_CALL}`,
    );

    expect(reconcileChromeRow(row("chrome.permission_justifications", REQUESTS), withHost).actual).toBe(
      `not synced yet (STORE.md carries 6 bullets under \`### Permissions justification\`, naming *://*/*): run ${CHROME_SYNC_CALL}`,
    );

    expect(reconcileChromeRow(row("chrome.permission_justifications", REQUESTS), withoutHost).actual).toBe(
      `${REQUESTS}; STORE.md carries 6 bullets under \`### Permissions justification\`, none naming *://*/*: add one bullet per host pattern, keyed by the pattern as the manifest spells it, for example \`- *://*/*: ${HOST_REASON}\`, then run ${CHROME_SYNC_CALL}`,
    );

    expect(reconcileChromeRow(row("chrome.permission_justifications", NO_BULLETS), empty).actual).toBe(NO_BULLETS);
    expect(reconcileChromeRow(row("chrome.title", NO_BULLETS), withHost).actual).toBe(NO_BULLETS);
  });

  it("answers the visibility check and row from the file's own line, naming the sync that writes it", () => {
    const check = reconcileChromeCheck({ id: "distribution.chrome_visibility", status: "warn", message: VISIBILITY_MESSAGE }, withHost);

    expect(check?.message).toBe(
      `A new Chrome item defaults to Public in the dashboard, and this project's intent is Unlisted (the least public default; STORE.md carries \`- Visibility: unlisted\`, not synced yet: run ${CHROME_SYNC_CALL}). Google's API does not answer visibility, so set and confirm it on the Distribution tab of the item's dashboard.`,
    );

    const differs = localOf(HANDS_FREE(`- *://*/*: ${HOST_REASON}`, "### Visibility\n\n- Visibility: public\n"));

    expect(reconcileChromeCheck({ id: "distribution.chrome_visibility", status: "warn", message: VISIBILITY_MESSAGE }, differs)?.message).toContain(
      `STORE.md carries \`- Visibility: public\`, not synced yet: run ${CHROME_SYNC_CALL} and the intent reads Public)`,
    );

    const odd = localOf(HANDS_FREE(`- *://*/*: ${HOST_REASON}`, "### Visibility\n\n- Visibility: everyone\n"));

    expect(reconcileChromeCheck({ id: "distribution.chrome_visibility", status: "warn", message: VISIBILITY_MESSAGE }, odd)?.message).toContain(
      "(the least public default; the `- Visibility:` line in STORE.md is not public, unlisted or private",
    );

    expect(reconcileChromeCheck({ id: "distribution.chrome_visibility", status: "warn", message: VISIBILITY_MESSAGE }, empty)).toBeNull();

    const actual = "a new item starts Public on the Distribution tab; the project's intent is Unlisted (the least public default; STORE.md has no `- Visibility:` line)";

    expect(reconcileChromeRow(row("chrome.visibility", actual, "unknown"), withHost).actual).toBe(
      `a new item starts Public on the Distribution tab; the project's intent is Unlisted (the least public default; STORE.md carries \`- Visibility: unlisted\`, not synced yet: run ${CHROME_SYNC_CALL})`,
    );
  });

  it("answers the host check from the file's bullets, or asks for the form that works with one example", () => {
    expect(reconcileChromeCheck({ id: "listing.chrome_host_justifications", status: "warn", message: HOST_MESSAGE }, withHost)?.message).toBe(
      "*://*/* is named by a bullet under `### Permissions justification` in STORE.md, not yet in the listing record; sync-listing writes it.",
    );

    expect(reconcileChromeCheck({ id: "listing.chrome_host_justifications", status: "warn", message: HOST_MESSAGE }, withoutHost)?.message).toBe(
      `${HOST_MESSAGE} STORE.md does not name *://*/* yet (6 bullets read): write one bullet per host pattern, keyed by the pattern as the manifest spells it, for example \`- *://*/*: ${HOST_REASON}\`, then run ${CHROME_SYNC_CALL}.`,
    );

    expect(reconcileChromeCheck({ id: "listing.chrome_host_justifications", status: "pass", message: "Every host pattern is named." }, withoutHost)).toBeNull();
    expect(reconcileChromeCheck({ id: "listing.privacy_policy_present", status: "warn", message: HOST_MESSAGE }, withHost)).toBeNull();
  });
});
