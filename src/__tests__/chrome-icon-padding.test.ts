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

import { chromeIconPadding, measureIconArt } from "../lib/chrome-icon-padding";
import { handler as validate } from "../tools/manifest-validate";
import { handler as submit } from "../tools/submit";
import { circle, iconPng, square } from "./fixtures/icon-art";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const FULL_BLEED = iconPng(() => true);
const WIDE_ART = iconPng(square(108));
const PADDED = iconPng(square(96));
const MANIFEST = JSON.stringify({ manifest_version: 3, name: "Rebeccat", version: "0.3.0", icons: { "16": "images/icon-16.png", "128": "images/icon-128.png" } });
const STORE_MD = "# Store metadata\n\n## Listing\n\n- Name: Rebeccat\n- Summary: A cat on every tab.\n";

function project(icon: Buffer): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-icon-padding-"));
  fs.mkdirSync(path.join(root, "src", "images"), { recursive: true });
  fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);
  fs.writeFileSync(path.join(root, "src", "manifest.json"), MANIFEST);
  fs.writeFileSync(path.join(root, "src", "images", "icon-128.png"), icon);
  fs.writeFileSync(path.join(root, "src", "images", "icon-16.png"), iconPng(() => true, 16));

  return root;
}

describe("the 128 px icon is measured against the Chrome Web Store padding rule (ledger 355)", () => {
  it("measures the opaque box and its padding per side from the alpha channel", () => {
    expect(measureIconArt(WIDE_ART)).toEqual({ width: 108, height: 108, padding: { left: 10, right: 10, top: 10, bottom: 10 }, shape: "square" });
    expect(measureIconArt(iconPng(square(96, 0)))).toMatchObject({ padding: { left: 0, right: 32, top: 0, bottom: 32 } });
    expect(measureIconArt(iconPng(circle(112)))).toMatchObject({ width: 112, height: 112, shape: "round" });
    expect(measureIconArt(iconPng(() => false))).toEqual({ empty: true });
  });

  it("names a full-bleed tile and a 108 px tile with the measured box, the fix and the sizes that need no padding", () => {
    const full = chromeIconPadding(FULL_BLEED, "src/images/icon-128.png");
    const wide = chromeIconPadding(WIDE_ART, "store/review/store-icon-128.png");

    expect(full?.say).toBe(
      "src/images/icon-128.png, the 128 px icon, has square art 128x128 with 0 px of padding per side. The Chrome Web Store asks for 96x96 art with 16 px of transparent padding per side on the 128 px icon (squarish art 75 to 80 percent of the width, round art about 112 px across), so as it is the store shows a tile that looks larger than its neighbors in the store and on chrome://extensions; resize the art to 96 px and extend 16 px of transparent canvas per side. The 16, 32 and 48 px icons need no padding. Chrome does not refuse the upload over this; it is advice (https://developer.chrome.com/docs/webstore/images).",
    );

    expect(wide?.say).toContain("has square art 108x108 with 10 px of padding per side");
    expect(chromeIconPadding(iconPng(square(96, 0)), "a.png")?.say).toContain("padding of 0 px left, 32 px right, 0 px top and 32 px bottom");
    expect(chromeIconPadding(iconPng(square(96, 0)), "a.png")?.say).toContain("off center");
    expect(chromeIconPadding(iconPng(circle(128)), "a.png")?.say).toContain("resize the circle to about 112 px across");
  });

  it("says nothing for art that follows the rule, or for an image that is not 128 px", () => {
    expect(chromeIconPadding(PADDED, "a.png")).toBeNull();
    expect(chromeIconPadding(iconPng(square(100)), "a.png")).toBeNull();
    expect(chromeIconPadding(iconPng(circle(112)), "a.png")).toBeNull();
    expect(chromeIconPadding(iconPng(() => true, 48), "a.png")).toBeNull();
  });

  it("extension_manifest_validate warns at dev time for a Chromium target and stays quiet for Firefox alone", async () => {
    const root = project(FULL_BLEED);
    const chrome = JSON.parse(await validate({ projectPath: root, browsers: ["chrome"] }));
    const firefox = JSON.parse(await validate({ projectPath: root, browsers: ["firefox"] }));
    const padded = JSON.parse(await validate({ projectPath: project(PADDED), browsers: ["chrome"] }));
    const says = (answer: { value: { warnings?: string[] }; warnings?: string[] }) => JSON.stringify(answer);

    expect(says(chrome)).toContain(JSON.stringify(`${path.join("src", "images", "icon-128.png")}, the 128 px icon, has square art 128x128 with 0 px of padding per side`).slice(1, -1));
    expect(says(firefox)).not.toContain("the 128 px icon, has");
    expect(says(padded)).not.toContain("the 128 px icon, has");
  });
});

describe("extension_submit carries the padding advice for Chrome (ledger 355)", () => {
  const platform = useProjectRoutes("extdev-icon-padding-routes-");

  beforeEach(() => {
    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/stores/chrome/submissions/preflight`] = () => ({ body: { store: "chrome", summary: { canSubmit: true }, checks: [] } });
    platform.routes[`GET ${PROJECT_ROUTE}/builds`] = () => ({ body: { items: [] } });
    platform.routes[`PUT ${PROJECT_ROUTE}/stores/chrome/listing`] = (call) => ({ body: { ok: true, store: "chrome", changes: [`icons: ${call.body.media?.icons?.length ?? 0}`] } });
  });

  it("preflight reports the measured box beside the Chrome view and in the hint, and says nothing for a padded icon", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: project(FULL_BLEED), api: API }));
    const quiet = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: project(PADDED), api: API }));

    expect(out.value.stores.chrome.iconPadding).toMatchObject({
      source: "src/images/icon-128.png",
      fits: false,
      art: { width: 128, height: 128, padding: { left: 0, right: 0, top: 0, bottom: 0 }, shape: "square" },
    });

    expect(out.hint).toContain("has square art 128x128 with 0 px of padding per side");
    expect(quiet.value.stores.chrome.iconPadding).toBeUndefined();
    expect(JSON.stringify(quiet)).not.toContain("the 128 px icon, has");
  });

  it("sync-listing says the same about the icon it sends to Chrome", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome"], projectPath: project(WIDE_ART), api: API }));

    expect(JSON.stringify(out)).toContain("has square art 108x108 with 10 px of padding per side");
  });
});
