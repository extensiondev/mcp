import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { RECORD_UNREAD } from "../lib/listing-on-record";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const LISTING = `${PROJECT_ROUTE}/stores/chrome/listing`;
const PREFLIGHT = `${PROJECT_ROUTE}/stores/chrome/submissions/preflight`;

const STORE_MD = `# Store metadata

## Listing

- Name: Hands-free
- Summary: Read pages aloud with one click.
- Category: Productivity

## Chrome Web Store

### Single purpose

Read the open page aloud on demand.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-shots-record-"));
  fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);
  fs.mkdirSync(path.join(root, "dist", "chrome", "icons"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "chrome", "manifest.json"), JSON.stringify({ icons: { "128": "icons/128.png" } }));
  fs.writeFileSync(path.join(root, "dist", "chrome", "icons", "128.png"), png(128, 128));
  fs.mkdirSync(path.join(root, "shots"));
  fs.writeFileSync(path.join(root, "shots", "one.png"), png(1280, 800));
  fs.writeFileSync(path.join(root, "shots", "two.png"), png(1280, 800));

  return root;
}

const requirements = (held: number) => ({
  store: "chrome",
  items: [
    { id: "chrome.store_icon", label: "Store icon", required: true, format: "128x128 px PNG.", satisfiedBy: "store-dashboard", how: "Upload it.", status: "unknown", dashboardTab: "Store listing" },
    { id: "chrome.screenshots", label: "Screenshots", required: true, format: "1 to 5 images, 1280x800 px.", satisfiedBy: held ? "listing" : "store-dashboard", how: "Add them.", status: held ? "have" : "missing", ...(held ? { actual: `${held} screenshots (1280x800 x${held})` } : {}) },
  ],
});

const screenshotsRow = (out: { value: { stores: { chrome: { pasteInDashboard: { fields: Array<{ field: string; from: string | null }> } } } } }) =>
  out.value.stores.chrome.pasteInDashboard.fields.find((row) => row.field === "screenshots")!;

describe("a sync-listing not given screenshots answers the ones the record keeps", () => {
  const platform = useProjectRoutes("extdev-shots-record-");

  let root = "";
  let held = 0;

  beforeEach(() => {
    root = project();
    held = 0;
    platform.login();

    platform.routes[`PUT ${LISTING}`] = (call) => {
      const sent = Array.isArray(call.body.media?.screenshots) ? call.body.media.screenshots.length : 0;

      if (sent && held === sent) return { status: 409, body: { code: "NO_CHANGE", message: "The listing already reads this way." } };
      if (sent) held = sent;

      return { body: { ok: true, store: "chrome", changes: sent ? [`screenshots: none -> ${sent} x 1280x800`] : ['summary: "" -> "Read pages aloud with one click."'] } };
    };

    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: { checks: [], requirements: requirements(held), dashboardUrl: "https://chrome.google.com/webstore/devconsole/pub/item/edit" } });
  });

  it("the three-call sequence: sent, kept on the record, unchanged", async () => {
    if (process.platform === "win32") return;

    const first = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome"], projectPath: root, screenshots: ["shots/one.png", "shots/two.png"], api: API }));

    expect(first.status).toBe("listing-recorded");
    expect(first.value.stores.chrome.filled).toContain("screenshots");
    expect(first.value.stores.chrome.onRecord).toBeUndefined();
    expect(screenshotsRow(first).from).toBe("2 screenshots in the extension.dev listing record, sent by sync-listing");
    expect(held).toBe(2);

    fs.appendFileSync(path.join(root, "STORE.md"), "- Homepage: https://example.com/hands-free\n");

    const second = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome"], projectPath: root, api: API }));
    const put = platform.sent("PUT", LISTING).slice(-1)[0]!.body;

    expect(put.media?.screenshots).toBeUndefined();
    expect(second.status).toBe("listing-recorded");
    expect(second.value.stores.chrome.filled).not.toContain("screenshots");
    expect(second.value.stores.chrome.onRecord).toEqual({ screenshots: "2 screenshots (1280x800 x2)" });
    expect(screenshotsRow(second).from).toBe("2 screenshots (1280x800 x2) on the extension.dev listing record, kept from an earlier sync-listing; this call sent none");
    expect(second.value.sayToPerson).toContain("This call sent no screenshots; the extension.dev listing record keeps 2 screenshots (1280x800 x2) from an earlier sync-listing, which clear the Chrome Web Store Screenshots row");
    expect(second.value.sayToPerson).not.toContain("0 screenshots");
    expect(screenshotsRow(second).from).not.toBeNull();

    const third = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome"], projectPath: root, screenshots: ["shots/one.png", "shots/two.png"], api: API }));

    expect(third.value.stores.chrome.status).toBe("unchanged");
    expect(third.value.stores.chrome.filled).toContain("screenshots");
    expect(third.value.stores.chrome.onRecord).toBeUndefined();
    expect(screenshotsRow(third).from).toBe("2 screenshots in the extension.dev listing record, sent by sync-listing");
  });

  it("says it did not look when the record could not be read back, never from null", async () => {
    if (process.platform === "win32") return;

    held = 2;
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ status: 503, body: { message: "preflight unavailable" } });

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome"], projectPath: root, waitSeconds: 0, api: API }));

    expect(out.value.stores.chrome.onRecord).toEqual({ unread: RECORD_UNREAD });
    expect(screenshotsRow(out).from).toBe(`not read: ${RECORD_UNREAD}`);
    expect(out.value.sayToPerson).toContain(`This call sent no screenshots, and ${RECORD_UNREAD}.`);
  });

  it("answers from null only when the record was read and holds none", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome"], projectPath: root, api: API }));

    expect(out.value.stores.chrome.onRecord).toBeUndefined();
    expect(screenshotsRow(out).from).toBeNull();
    expect(out.value.sayToPerson).not.toContain("This call sent no screenshots");
  });
});
