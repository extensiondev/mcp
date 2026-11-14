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
});
