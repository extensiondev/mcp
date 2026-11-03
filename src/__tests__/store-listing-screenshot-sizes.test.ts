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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-shot-sizes-"));
  fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);
  fs.mkdirSync(path.join(root, "dist", "chrome", "icons"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "dist", "chrome", "manifest.json"),
    JSON.stringify({ icons: { "128": "icons/128.png" } }),
  );

  fs.writeFileSync(path.join(root, "dist", "chrome", "icons", "128.png"), solidPng(128, 128));
  fs.mkdirSync(path.join(root, "shots"));

  return root;
}

function shots(root: string, sizes: Array<[number, number]>): string[] {
  return sizes.map(([width, height], index) => {
    const relative = path.join("shots", `${index + 1}.png`);
    fs.writeFileSync(path.join(root, relative), solidPng(width, height));

    return relative;
  });
}

describe("sync-listing measures screenshots against the store's own sizes before any approval", () => {
  const platform = useProjectRoutes("extdev-shot-sizes-api-");
  let root = "";

  beforeEach(() => {
    root = project();
    platform.login();
  });

  it("refuses a 640x400 PNG for safari, naming the file, its size and Apple's four sizes, and sends nothing", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(
      await submit({
        action: "sync-listing",
        browsers: ["safari"],
        projectPath: root,
        screenshots: shots(root, [[640, 400]]),
        api: API,
      }),
    );

    expect(out.status).toBe("bad-request");
    expect(out.error.name).toBe("ListingInputError");
    expect(out.error.message).toContain("shots/1.png is 640x400");
    expect(out.error.message).toContain("1280x800, 1440x900, 2560x1600, 2880x1800");
    expect(out.error.message).toContain("Nothing was sent");
    expect(out.value.screenshot).toMatchObject({ store: "safari", file: "shots/1.png", measured: "640x400" });
    expect(platform.calls).toHaveLength(0);
  });

  it("sends a 2880x1800 PNG for safari on to the platform", async () => {
    if (process.platform === "win32") return;

    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({ body: { checks: [] } });

    await submit({
      action: "sync-listing",
      browsers: ["safari"],
      projectPath: root,
      screenshots: shots(root, [[2880, 1800]]),
      api: API,
    });

    const put = platform.sent("PUT", LISTING("safari"));

    expect(put).toHaveLength(1);
    expect(Buffer.from(put[0]!.body.media.screenshots[0].dataBase64, "base64").readUInt32BE(16)).toBe(2880);
  });

  it("refuses six PNGs for chrome, whose listing takes five, and sends nothing", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(
      await submit({
        action: "sync-listing",
        browsers: ["chrome"],
        projectPath: root,
        screenshots: shots(root, Array.from({ length: 6 }, () => [1280, 800] as [number, number])),
        api: API,
      }),
    );

    expect(out.status).toBe("bad-request");
    expect(out.error.name).toBe("ListingInputError");
    expect(out.error.message).toMatch(/chrome.*at most 5.*6 were given/);
    expect(platform.calls).toHaveLength(0);
  });

  it("sends ten PNGs for safari on to the platform", async () => {
    if (process.platform === "win32") return;

    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({ body: { checks: [] } });

    await submit({
      action: "sync-listing",
      browsers: ["safari"],
      projectPath: root,
      screenshots: shots(root, Array.from({ length: 10 }, () => [1440, 900] as [number, number])),
      api: API,
    });

    const put = platform.sent("PUT", LISTING("safari"));

    expect(put).toHaveLength(1);
    expect(put[0]!.body.media.screenshots).toHaveLength(10);
  });

  it("names Apple's count and sizes on the preflight's safari screenshots row", async () => {
    if (process.platform === "win32") return;

    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({
      body: {
        summary: { canSubmit: false },
        checks: [{ id: "listing.safari_screenshots_present", status: "fail" }],
      },
    });

    const out = JSON.parse(
      await submit({ action: "preflight", browsers: ["safari"], projectPath: root, api: API }),
    );
    const line = out.value.stores.safari.storeMd.notCovered.find((row: string) => row.startsWith("screenshots"));

    expect(line).toContain("the App Store takes 1 to 10 screenshots at 1280x800 or 1440x900 or 2560x1600 or 2880x1800 px");
  });
});
