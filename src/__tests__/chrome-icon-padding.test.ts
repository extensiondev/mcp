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

import { handler as validate } from "../tools/manifest-validate";
import { handler as submit } from "../tools/submit";
import { iconPng } from "./fixtures/icon-art";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const FULL_BLEED = iconPng(() => true);
const MANIFEST = JSON.stringify({ manifest_version: 3, name: "Rebeccat", version: "0.3.0", icons: { "16": "images/icon-16.png", "128": "images/icon-128.png" } });
const STORE_MD = "# Store metadata\n\n## Listing\n\n- Name: Rebeccat\n- Summary: A cat on every tab.\n";
const ART_ADVICE = /padding|margin|96 ?px|96x96|art size|off center/i;

function project(icon: Buffer): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-icon-art-"));
  fs.mkdirSync(path.join(root, "src", "images"), { recursive: true });
  fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);
  fs.writeFileSync(path.join(root, "src", "manifest.json"), MANIFEST);
  fs.writeFileSync(path.join(root, "src", "images", "icon-128.png"), icon);
  fs.writeFileSync(path.join(root, "src", "images", "icon-16.png"), iconPng(() => true, 16));

  return root;
}

describe("the MCP never comments on how a full-bleed 128 px logo is drawn (ledger 559)", () => {
  const platform = useProjectRoutes("extdev-icon-art-routes-");

  beforeEach(() => {
    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/stores/chrome/submissions/preflight`] = () => ({ body: { store: "chrome", summary: { canSubmit: true }, checks: [] } });
    platform.routes[`GET ${PROJECT_ROUTE}/builds`] = () => ({ body: { items: [] } });
    platform.routes[`PUT ${PROJECT_ROUTE}/stores/chrome/listing`] = (call) => ({ body: { ok: true, store: "chrome", changes: [`icons: ${call.body.media?.icons?.length ?? 0}`] } });
  });

  it("extension_manifest_validate for a Chromium target says nothing about padding, margin or 96 px", async () => {
    const answer = await validate({ projectPath: project(FULL_BLEED), browsers: ["chrome"] });

    expect(answer).not.toMatch(ART_ADVICE);
  });

  it("preflight carries no icon art field and no sentence about padding, margin or 96 px", async () => {
    if (process.platform === "win32") return;

    const answer = await submit({ action: "preflight", browsers: ["chrome"], projectPath: project(FULL_BLEED), api: API });

    expect(JSON.parse(answer).value.stores.chrome).not.toHaveProperty("iconPadding");
    expect(answer).not.toMatch(ART_ADVICE);
  });

  it("sync-listing sends the icon as it is and says nothing about padding, margin or 96 px", async () => {
    if (process.platform === "win32") return;

    const answer = await submit({ action: "sync-listing", browsers: ["chrome"], projectPath: project(FULL_BLEED), api: API });

    expect(answer).not.toMatch(ART_ADVICE);
  });
});
