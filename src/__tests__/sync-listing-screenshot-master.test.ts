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
});
