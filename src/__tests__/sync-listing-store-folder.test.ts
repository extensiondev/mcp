import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit";
import { solidPng } from "./fixtures/png";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const LISTING = (store: string) => `${PROJECT_ROUTE}/stores/${store}/listing`;
const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;

const STORE_MD = `# Store metadata

## Listing

- Name: PII Shield
- Summary: Hide personal information on every open tab with one click.
`;

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-store-folder-"));
  fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);
  fs.mkdirSync(path.join(root, "dist", "chrome", "icons"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "chrome", "manifest.json"), JSON.stringify({ icons: { "128": "icons/128.png" } }));
  fs.writeFileSync(path.join(root, "dist", "chrome", "icons", "128.png"), solidPng(128, 128));

  return root;
}

function folder(root: string, store: string, files: Record<string, [number, number]>): void {
  const dir = path.join(root, "store", "screenshots", store);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, [width, height]] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), solidPng(width, height));
}

const sent = (body: { media?: { screenshots?: Array<{ dataBase64: string }> } }) =>
  (body.media?.screenshots ?? []).map((shot) => {
    const bytes = Buffer.from(shot.dataBase64, "base64");

    return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
  });

describe("sync-listing with no screenshots argument reads each store's folder under store/screenshots", () => {
  const platform = useProjectRoutes("extdev-store-folder-api-");
  let root = "";

  beforeEach(() => {
    root = project();
    platform.login();
    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({ body: { checks: [] } });
    platform.routes[`POST ${PREFLIGHT("firefox")}`] = () => ({ body: { checks: [] } });
    platform.routes[`PUT ${LISTING("safari")}`] = () => ({ body: { ok: true, store: "safari", changes: ["screenshots: none -> 3"] } });
    platform.routes[`PUT ${LISTING("firefox")}`] = () => ({ body: { ok: true, store: "firefox", changes: ["screenshots: none -> 1"] } });
  });

  it("sends store/screenshots/safari/*.png in filename order and names the folder it read", async () => {
    if (process.platform === "win32") return;

    folder(root, "safari", { "10.png": [1440, 900], "02.png": [2880, 1800], "01.png": [2560, 1600], "notes.txt": [1, 1] });

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["safari"], projectPath: root, api: API }));
    const put = platform.sent("PUT", LISTING("safari"));

    expect(put).toHaveLength(1);
    expect(sent(put[0]!.body)).toEqual(["2560x1600", "2880x1800", "1440x900"]);
    expect(out.value.stores.safari.screenshotsFrom).toEqual({ folder: "store/screenshots/safari", files: ["01.png", "02.png", "10.png"] });
    expect(out.value.sayToPerson).toContain("3 screenshots were read from store/screenshots/safari (01.png, 02.png, 10.png)");
  });

  it("reads firefox's own folder, and an explicit screenshots list still wins over the folder", async () => {
    if (process.platform === "win32") return;

    folder(root, "firefox", { "01.png": [1280, 800] });
    folder(root, "safari", { "01.png": [2880, 1800] });
    fs.mkdirSync(path.join(root, "shots"));
    fs.writeFileSync(path.join(root, "shots", "given.png"), solidPng(1440, 900));

    const fromFolder = JSON.parse(await submit({ action: "sync-listing", browsers: ["firefox"], projectPath: root, api: API }));

    expect(sent(platform.sent("PUT", LISTING("firefox"))[0]!.body)).toEqual(["1280x800"]);
    expect(fromFolder.value.stores.firefox.screenshotsFrom.folder).toBe("store/screenshots/firefox");

    const given = JSON.parse(await submit({ action: "sync-listing", browsers: ["safari"], projectPath: root, screenshots: ["shots/given.png"], api: API }));

    expect(sent(platform.sent("PUT", LISTING("safari"))[0]!.body)).toEqual(["1440x900"]);
    expect(given.value.stores.safari.screenshotsFrom).toBeUndefined();
  });

  it("refuses a folder file off the store's sizes before any approval, naming the file", async () => {
    if (process.platform === "win32") return;

    folder(root, "safari", { "01.png": [1280, 800], "02.png": [640, 400] });

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["safari"], projectPath: root, api: API }));

    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("store/screenshots/safari/02.png is 640x400");
    expect(out.hint).toContain('extension_screenshot store:"safari"');
    expect(platform.calls).toHaveLength(0);
  });
});

describe("preflight names the capture recipe for every store whose screenshots row is missing", () => {
  const platform = useProjectRoutes("extdev-store-folder-preflight-");
  let root = "";

  const requirement = (store: string, required: boolean, status: "missing" | "have") => ({
    store,
    items: [
      {
        id: `${store}.screenshots`,
        label: "Screenshots",
        required,
        format: "Screenshots as the store asks.",
        satisfiedBy: "listing",
        how: "Add them.",
        status,
        ...(status === "missing" ? { actual: "0 screenshots" } : {}),
      },
    ],
    missingRequired: required && status === "missing" ? 1 : 0,
    missingOptional: !required && status === "missing" ? 1 : 0,
  });

  beforeEach(() => {
    root = project();
    platform.login();
  });

  it("an optional-screenshots store with no other failing check gets the capture as its next step, not null", async () => {
    if (process.platform === "win32") return;

    platform.routes[`POST ${PREFLIGHT("firefox")}`] = () => ({
      body: { summary: { canSubmit: true }, checks: [], requirements: requirement("firefox", false, "missing") },
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], projectPath: root, api: API }));
    const recipe = 'Screenshots for firefox: extension_screenshot store:"firefox" on a Chromium dev session, one call per view, then sync-listing browsers:["firefox"] picks them up from store/screenshots/firefox/.';

    expect(out.hint).toContain(recipe);
    expect(out.value.sayToPerson).toContain(recipe);
    expect(out.value.nextStep).toMatchObject({ kind: "screenshot" });
    expect(out.value.nextStep.say).toContain(recipe);
  });

  it("a required safari row names a Safari dev session, and a store whose row is on file gets no recipe", async () => {
    if (process.platform === "win32") return;

    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({
      body: {
        summary: { canSubmit: false },
        checks: [{ id: "listing.safari_screenshots_present", status: "fail", severity: "blocking", message: "Add a screenshot." }],
        requirements: requirement("safari", true, "missing"),
      },
    });

    platform.routes[`POST ${PREFLIGHT("firefox")}`] = () => ({
      body: { summary: { canSubmit: true }, checks: [], requirements: requirement("firefox", false, "have") },
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["safari", "firefox"], projectPath: root, api: API }));

    expect(out.hint).toContain('Screenshots for safari: extension_screenshot store:"safari" on a Safari dev session, one call per view, then sync-listing browsers:["safari"] picks them up from store/screenshots/safari/.');
    expect(out.hint).not.toContain("Screenshots for firefox");
    expect(out.value.nextStep).toMatchObject({ kind: "screenshot" });
  });
});
