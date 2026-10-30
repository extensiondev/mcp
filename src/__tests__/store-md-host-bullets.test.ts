import { describe, expect, it } from "vitest";

import { bulletLine } from "../lib/store-md-bullets";
import { bulletNamesHost, namesNotInBullets, patternCovers, uncoveredNamesIn } from "../lib/store-md-host-justifications";
import { listingForStore, parseStoreMdListing } from "../lib/store-md-listing";

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
