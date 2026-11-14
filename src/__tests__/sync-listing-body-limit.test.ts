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

import { PLATFORM_REQUEST_BODY_LIMIT_BYTES } from "../lib/listing-body-limit";
import { handler as submit } from "../tools/submit-local";
import { solidPng } from "./fixtures/png";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const LISTING = `${PROJECT_ROUTE}/stores/safari/listing`;
const PREFLIGHT = `${PROJECT_ROUTE}/stores/safari/submissions/preflight`;
const MB = 1024 * 1024;
const BIG = 1_600_000;
const MID = 1_500_000;

const STORE_MD = `# Store metadata

## Listing

- Name: PII Shield
- Summary: Hide personal information on every open tab with one click.
`;

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-body-limit-"));
  fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);
  fs.mkdirSync(path.join(root, "dist", "safari", "icons"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "safari", "manifest.json"), JSON.stringify({ icons: { "128": "icons/128.png" } }));
  fs.writeFileSync(path.join(root, "dist", "safari", "icons", "128.png"), solidPng(128, 128));
  fs.mkdirSync(path.join(root, "shots"));

  return root;
}

function shot(root: string, name: string, bytes: number): string {
  const png = solidPng(2560, 1600);
  const relative = path.join("shots", name);
  fs.writeFileSync(path.join(root, relative), bytes > png.length ? Buffer.concat([png, Buffer.alloc(bytes - png.length)]) : png);

  return relative;
}

function heavySet(root: string): string[] {
  return [shot(root, "1.png", MID), shot(root, "2.png", BIG), shot(root, "3.png", MID)];
}

async function sync(root: string, screenshots: string[]): Promise<any> {
  return JSON.parse(await submit({ action: "sync-listing", browsers: ["safari"], projectPath: root, screenshots, api: API }));
}

describe("sync-listing measures the request body against the platform's limit before sending it", () => {
  const platform = useProjectRoutes("extdev-body-limit-api-");
  let root = "";

  beforeEach(() => {
    root = project();
    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: { checks: [] } });
    platform.routes[`PUT ${LISTING}`] = () => ({ body: { changes: ["screenshots"] } });
  });

  it("names the platform's request body limit once, 4.5 MB", () => {
    expect(PLATFORM_REQUEST_BODY_LIMIT_BYTES).toBe(4_500_000);
  });

  it("refuses three 1.5 MB 2560x1600 PNGs before any PUT, with the limit, the measured total, the biggest file first and the fix", async () => {
    if (process.platform === "win32") return;

    const out = await sync(root, heavySet(root));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("listing-too-large");
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.name).toBe("ListingTooLarge");
    expect(platform.sent("PUT", LISTING)).toHaveLength(0);

    const body = out.value.listing.body;
    expect(body.limitBytes).toBe(4_500_000);
    expect(body.bytes).toBeGreaterThan(4_500_000);
    expect(body.files.map((file: any) => file.name)).toEqual(["shots/2.png", "shots/1.png", "shots/3.png"]);
    expect(body.files[0]).toEqual({ name: "shots/2.png", bytes: BIG, width: 2560, height: 1600 });
    expect(out.error.message).toBe(`safari: the sync-listing request body measures ${body.bytes} bytes, over the 4500000-byte request body limit (Vercel request body limit). Nothing was written to the listing by this call.`);
    expect(out.hint).toContain("base64-encoded, which adds a third");
    expect(out.hint).toContain(`Files, biggest first: shots/2.png ${BIG} bytes at 2560x1600, shots/1.png ${MID} bytes at 2560x1600, shots/3.png ${MID} bytes at 2560x1600.`);
    expect(out.hint).toContain("Fix: 2 of these fit in one call, so send them in 2 calls of sync-listing");
    expect(out.hint).toContain("or capture at 1280x800, which the App Store accepts too");
  });

  it("sends three small 2560x1600 PNGs through unchanged", async () => {
    if (process.platform === "win32") return;

    const out = await sync(root, [shot(root, "a.png", 0), shot(root, "b.png", 0), shot(root, "c.png", 0)]);
    const put = platform.sent("PUT", LISTING);

    expect(out.ok).toBe(true);
    expect(put).toHaveLength(1);
    expect(put[0]!.body.media.screenshots).toHaveLength(3);
    expect(Buffer.from(put[0]!.body.media.screenshots[0].dataBase64, "base64").equals(solidPng(2560, 1600))).toBe(true);
    expect(out.value.listing?.body).toBeUndefined();
  });

  it("maps a platform 413 to the same status and hint, saying the platform refused the body, never a bare 'answered 413'", async () => {
    if (process.platform === "win32") return;

    platform.routes[`PUT ${LISTING}`] = () => ({ status: 413, body: "<html><body>Request Entity Too Large</body></html>" });
    const set = [shot(root, "x.png", 2 * MB), shot(root, "y.png", MB)];
    const out = await sync(root, set);

    expect(out.ok).toBe(false);
    expect(out.status).toBe("listing-too-large");
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.value.platformStatus).toBe(413);
    expect(out.value.listing.body.files.map((file: any) => file.name)).toEqual(["shots/x.png", "shots/y.png"]);
    expect(out.error.message).toContain("safari: the platform refused the body as too large (413); it measures");
    expect(out.error.message).toContain("over the 4500000-byte request body limit (Vercel request body limit)");
    expect(out.error.message).not.toContain("answered 413");
    expect(out.hint).toContain(`Files, biggest first: shots/x.png ${2 * MB} bytes at 2560x1600, shots/y.png ${MB} bytes at 2560x1600.`);
    expect(out.hint).toContain("Fix: by this measure the whole set fits, so the platform's cap is below the one named here; send one screenshot per call");
    expect(platform.sent("PUT", LISTING)).toHaveLength(1);
  });
});
