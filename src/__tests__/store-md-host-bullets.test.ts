import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { bulletLine, storeOwnLinesBody } from "../lib/store-md-bullets";
import { listingForStore, parseStoreMdListing } from "../lib/store-md-listing";
import { readLocalListing } from "../lib/submit-facts-local";
import type { LocalListing } from "../lib/store-listing-local";

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
