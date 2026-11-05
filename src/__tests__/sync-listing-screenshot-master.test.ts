// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { MAX_SCREENSHOT_BYTES, MAX_SCREENSHOT_MASTER_BYTES } from "../lib/store-listing-media";
import { handler as submit } from "../tools/submit";
import { solidPng } from "./fixtures/png";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const LISTING = (store: string) => `${PROJECT_ROUTE}/stores/${store}/listing`;
const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const TWO_MB = 2 * 1024 * 1024;

const STORE_MD = `# Store metadata

## Listing

- Name: PII Shield
- Summary: Hide personal information on every open tab with one click.
`;

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-shot-master-"));
  fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);

  for (const store of ["chrome", "edge", "safari", "firefox"]) {
    fs.mkdirSync(path.join(root, "dist", store, "icons"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", store, "manifest.json"), JSON.stringify({ icons: { "128": "icons/128.png" } }));
    fs.writeFileSync(path.join(root, "dist", store, "icons", "128.png"), solidPng(128, 128));
  }

  fs.mkdirSync(path.join(root, "shots"));

  return root;
}

function heavyShot(root: string, width: number, height: number, bytes: number): string {
  const png = solidPng(width, height);
  const relative = path.join("shots", `${width}x${height}.png`);
  fs.writeFileSync(path.join(root, relative), Buffer.concat([png, Buffer.alloc(bytes - png.length)]));

  return relative;
}

describe("sync-listing takes a screenshot master over 1 MB only for the stores that receive it resized or whole", () => {
  const platform = useProjectRoutes("extdev-shot-master-api-");
  let root = "";

  beforeEach(() => {
    root = project();
    platform.login();

    for (const store of ["chrome", "edge", "safari", "firefox"]) {
      platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: { checks: [] } });
    }
  });

  it("holds the master at the platform's write cap of 3 MB and the store copy at 1 MB", () => {
    expect(MAX_SCREENSHOT_MASTER_BYTES).toBe(3 * 1024 * 1024);
    expect(MAX_SCREENSHOT_BYTES).toBe(1024 * 1024);
  });

  it("sends a 2 MB 2880x1800 PNG for chrome and edge, which receive the platform's 1280x800 copy", async () => {
    if (process.platform === "win32") return;

    await submit({
      action: "sync-listing",
      browsers: ["chrome", "edge"],
      projectPath: root,
      screenshots: [heavyShot(root, 2880, 1800, TWO_MB)],
      api: API,
    });

    for (const store of ["chrome", "edge"]) {
      const put = platform.sent("PUT", LISTING(store));

      expect(put).toHaveLength(1);
      expect(Buffer.from(put[0]!.body.media.screenshots[0].dataBase64, "base64").length).toBe(TWO_MB);
    }
  });

  it("sends the same 2 MB master to safari unresized and to firefox for the platform's 1280x800 copy", async () => {
    if (process.platform === "win32") return;

    await submit({
      action: "sync-listing",
      browsers: ["chrome", "safari", "firefox"],
      projectPath: root,
      screenshots: [heavyShot(root, 2880, 1800, TWO_MB)],
      api: API,
    });

    for (const store of ["chrome", "safari", "firefox"]) {
      const put = platform.sent("PUT", LISTING(store));

      expect(put).toHaveLength(1);
      expect(Buffer.from(put[0]!.body.media.screenshots[0].dataBase64, "base64").length).toBe(TWO_MB);
    }
  });

  it("refuses a 2 MB firefox image the platform would send as it is, and a 2 MB 1280x800 PNG for chrome, and sends nothing", async () => {
    if (process.platform === "win32") return;

    const firefox = JSON.parse(
      await submit({ action: "sync-listing", browsers: ["firefox"], projectPath: root, screenshots: [heavyShot(root, 1600, 900, TWO_MB)], api: API }),
    );

    expect(firefox.status).toBe("bad-request");
    expect(firefox.error.message).toContain(`the platform sends it to Firefox Add-ons as it is, and a listing image it sends there is at most ${MAX_SCREENSHOT_BYTES} bytes`);

    const asIs = JSON.parse(
      await submit({ action: "sync-listing", browsers: ["chrome"], projectPath: root, screenshots: [heavyShot(root, 1280, 800, TWO_MB)], api: API }),
    );

    expect(asIs.status).toBe("bad-request");
    expect(asIs.error.message).toContain("the platform sends it to the Chrome Web Store as it is");
    expect(platform.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("refuses a safari master over the 3 MB write cap before anything is sent", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(
      await submit({
        action: "sync-listing",
        browsers: ["safari"],
        projectPath: root,
        screenshots: [heavyShot(root, 2880, 1800, MAX_SCREENSHOT_MASTER_BYTES + 1)],
        api: API,
      }),
    );

    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain(`over the ${MAX_SCREENSHOT_MASTER_BYTES} a listing image takes`);
    expect(platform.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("prints the platform's refusal of a derived copy over 1 MB verbatim", async () => {
    if (process.platform === "win32") return;

    const said = "a media.screenshots image the chrome listing would receive is 1200000 bytes at 1280x800, over the 1048576 a chrome listing stores";
    platform.routes[`PUT ${LISTING("chrome")}`] = () => ({ status: 400, body: { code: "INVALID_LISTING", message: said } });

    const out = JSON.parse(
      await submit({ action: "sync-listing", browsers: ["chrome"], projectPath: root, screenshots: [heavyShot(root, 2880, 1800, TWO_MB)], api: API }),
    );

    expect(out.ok).toBe(false);
    expect(out.error.message).toBe(`chrome: ${said}`);
  });
});
