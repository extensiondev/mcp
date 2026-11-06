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

import { STAGED_IMAGE_MAX_BYTES, STAGED_IMAGES_PER_STORE, stageListingImages, stagedImageGuard } from "../lib/listing-image-stage";
import { handler as submit } from "../tools/submit";
import { solidPng } from "./fixtures/png";
import { API, PROJECT_ID, PROJECT_ROUTE, useProjectRoutes, type Call } from "./fixtures/project-routes";

import type { ListingImage, ListingPatch } from "../lib/store-listing-media";
import type { ProjectApi } from "../lib/project-api";

const LISTING = `${PROJECT_ROUTE}/stores/safari/listing`;
const IMAGES = `${LISTING}/images`;
const PREFLIGHT = `${PROJECT_ROUTE}/stores/safari/submissions/preflight`;

const STORE_MD = `# Store metadata

## Listing

- Name: PII Shield
- Summary: Hide personal information on every open tab with one click.
`;

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-image-stage-"));
  fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);
  fs.mkdirSync(path.join(root, "dist", "safari", "icons"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "safari", "manifest.json"), JSON.stringify({ icons: { "128": "icons/128.png" } }));
  fs.writeFileSync(path.join(root, "dist", "safari", "icons", "128.png"), solidPng(128, 128));
  fs.mkdirSync(path.join(root, "shots"));

  return root;
}

function shot(root: string, name: string, pad: number): string {
  const relative = path.join("shots", name);
  fs.writeFileSync(path.join(root, relative), Buffer.concat([solidPng(2560, 1600), Buffer.alloc(pad)]));

  return relative;
}

async function sync(root: string, screenshots: string[]): Promise<any> {
  return JSON.parse(await submit({ action: "sync-listing", browsers: ["safari"], projectPath: root, screenshots, api: API }));
}

function image(source: string, bytes: number): ListingImage {
  return { sha256: `local-${source}`, width: 2560, height: 1600, bytes: Buffer.alloc(bytes), source };
}

describe("sync-listing stages each image through the listing images door, then writes the listing by the answered shas", () => {
  const platform = useProjectRoutes("extdev-image-stage-api-");
  let root = "";
  let staged = 0;

  beforeEach(() => {
    root = project();
    staged = 0;
    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: { checks: [] } });
    platform.routes[`PUT ${LISTING}`] = () => ({ body: { changes: ["screenshots"] } });

    platform.routes[`PUT ${IMAGES}`] = (call: Call) => {
      staged += 1;

      return {
        body: {
          ok: true,
          store: "safari",
          kind: call.body.kind,
          image: { sha256: `answered-${staged}`, width: call.body.kind === "icons" ? 128 : 2560, height: call.body.kind === "icons" ? 128 : 1600, bytes: 1000 + staged },
          stagedAt: "2026-11-06T20:00:00Z",
        },
      };
    };
  });

  it("stages three screenshots as three PUTs, then sends one listing PUT naming the answered shas, never the local ones", async () => {
    if (process.platform === "win32") return;

    const out = await sync(root, [shot(root, "a.png", 1), shot(root, "b.png", 2), shot(root, "c.png", 3)]);
    const stages = platform.sent("PUT", IMAGES);
    const shots = stages.filter((call) => call.body.kind === "screenshots");
    const put = platform.sent("PUT", LISTING);

    expect(out.ok).toBe(true);
    expect(shots).toHaveLength(3);
    expect(Buffer.from(shots[0]!.body.dataBase64, "base64").length).toBe(solidPng(2560, 1600).length + 1);
    expect(put).toHaveLength(1);

    const callOrder = platform.calls.map((call) => `${call.method} ${call.path}`);
    expect(callOrder.lastIndexOf(`PUT ${IMAGES}`)).toBeLessThan(callOrder.indexOf(`PUT ${LISTING}`));

    const answered = stages.map((_, index) => `answered-${index + 1}`);
    const shas = put[0]!.body.media.screenshots.map((row: any) => row.sha256);
    expect(shas).toEqual(answered.slice(stages.length - 3));
    expect(put[0]!.body.media.screenshots[0]).toEqual({ sha256: shas[0], width: 2560, height: 1600 });
    expect(JSON.stringify(put[0]!.body)).not.toContain("dataBase64");

    const images = out.value.listing.images.filter((row: any) => row.kind === "screenshots");
    expect(images.map((row: any) => row.name)).toEqual(["shots/a.png", "shots/b.png", "shots/c.png"]);
    expect(images[0]).toMatchObject({ name: "shots/a.png", sha256: shas[0], width: 2560, height: 1600 });
    expect(out.value.listing.staged).toBe(stages.length);
    expect(out.value.sayToPerson).toContain(`${stages.length} images were staged one per request`);
    expect(out.warnings ?? []).not.toContain(expect.stringContaining("no listing images door"));
  });

  it("stops at a stage refused with INVALID_LISTING, naming the file, the code and the fix, and sends no listing PUT", async () => {
    if (process.platform === "win32") return;

    platform.routes[`PUT ${IMAGES}`] = (call: Call) =>
      call.body.kind === "screenshots"
        ? { status: 400, body: { code: "INVALID_LISTING", message: "The screenshot is not a PNG or JPEG the store takes." } }
        : { body: { ok: true, image: { sha256: "icon-sha", width: 128, height: 128, bytes: 10 } } };

    const out = await sync(root, [shot(root, "bad.png", 0), shot(root, "next.png", 0)]);

    expect(out.ok).toBe(false);
    expect(out.status).toBe("sync-listing-refused");
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toContain("shots/bad.png");
    expect(out.error.message).toContain("INVALID_LISTING");
    expect(out.value.image).toEqual({ name: "shots/bad.png", kind: "screenshots" });
    expect(out.hint).toContain("fix the file");
    expect(platform.sent("PUT", IMAGES).filter((call) => call.body.kind === "screenshots")).toHaveLength(1);
    expect(platform.sent("PUT", LISTING)).toHaveLength(0);
  });

  it("falls back to the single listing body with a warning when the platform answers 404 on the images door", async () => {
    if (process.platform === "win32") return;

    delete platform.routes[`PUT ${IMAGES}`];
    const out = await sync(root, [shot(root, "a.png", 0), shot(root, "b.png", 0)]);
    const put = platform.sent("PUT", LISTING);

    expect(out.ok).toBe(true);
    expect(platform.sent("PUT", IMAGES)).toHaveLength(1);
    expect(put).toHaveLength(1);
    expect(put[0]!.body.media.screenshots).toHaveLength(2);
    expect(Buffer.from(put[0]!.body.media.screenshots[0].dataBase64, "base64").equals(solidPng(2560, 1600))).toBe(true);
    expect(out.value.listing).toBeUndefined();
    expect(out.warnings).toEqual(expect.arrayContaining([expect.stringContaining("no listing images door yet (it answered 404 or 405)")]));
  });

  it("refuses an image over 3 MB as listing-too-large, naming the file, before any network call", () => {
    const patch: ListingPatch = { listing: {}, screenshots: [image("shots/ok.png", 10), image("shots/huge.png", STAGED_IMAGE_MAX_BYTES + 1)] };
    const out = JSON.parse(stagedImageGuard("safari", patch) ?? "{}");

    expect(out.ok).toBe(false);
    expect(out.status).toBe("listing-too-large");
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toContain(`shots/huge.png is ${STAGED_IMAGE_MAX_BYTES + 1} bytes`);
    expect(out.value.listing.image.name).toBe("shots/huge.png");
    expect(stagedImageGuard("safari", { listing: {}, screenshots: [image("shots/ok.png", 10)] })).toBeNull();
    expect(platform.calls).toHaveLength(0);
  });

  it("refuses a 41st image as listing-too-large, naming it, before any network call", () => {
    const shots = Array.from({ length: STAGED_IMAGES_PER_STORE + 1 }, (_, index) => image(`shots/${index + 1}.png`, 10));
    const out = JSON.parse(stagedImageGuard("safari", { listing: {}, screenshots: shots }) ?? "{}");

    expect(out.status).toBe("listing-too-large");
    expect(out.value.listing.count).toBe(41);
    expect(out.value.listing.image.name).toBe("shots/41.png");
    expect(out.error.message).toContain("over the 40 the platform stages for one store");
    expect(stagedImageGuard("safari", { listing: {}, screenshots: shots.slice(0, 40) })).toBeNull();
    expect(platform.calls).toHaveLength(0);
  });

  it("stages each image once per store, even when the listing write retries", async () => {
    const api = { base: API, token: "t", projectId: PROJECT_ID, ref: { workspace: "acme", project: "widget" }, command: "x" } as unknown as ProjectApi;
    const patch: ListingPatch = { listing: {}, screenshots: [image("shots/one.png", 10)] };
    platform.login();

    const first = await stageListingImages(api, "safari", patch);
    const again = await stageListingImages(api, "safari", patch);

    expect(first).toEqual(again);
    expect(platform.sent("PUT", IMAGES)).toHaveLength(1);
  });
});
