// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { localIcon } from "../lib/store-facts-local";
import { readZipEntry } from "../lib/zip-entries";
import { readLocalListing } from "../lib/submit-facts-local";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const LISTING = (store: string) => `${PROJECT_ROUTE}/stores/${store}/listing`;
const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const BUILDS = `${PROJECT_ROUTE}/builds`;
const PACKAGE = (sha: string, file: string) => `${PROJECT_ROUTE}/builds/${sha}/artifacts/${file}`;
const HEAD_BUILD = "6d9e10c";
const OLDER_BUILD = "e4804a9";

const STORE_MD = `# Store metadata

## Listing

- Name: PII Shield
- Summary: Hide personal information on every open tab with one click.
`;

function png(width: number, height: number, mark = 0): Buffer {
  const bytes = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt8(mark, 33);

  return bytes;
}

const NEW_ICON = png(128, 128, 2);
const OLD_ICON = png(128, 128, 1);
const MANIFEST = JSON.stringify({ icons: { "16": "images/icon-16.png", "128": "images/icon-128.png" } });

function zip(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const [name, data] of Object.entries(files)) {
    const encoded = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(encoded.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(encoded.length, 28);
    central.writeUInt32LE(offset, 42);

    parts.push(local, encoded, data);
    directory.push(central, encoded);
    offset += local.length + encoded.length + data.length;
  }

  const listing = Buffer.concat(directory);
  const count = Object.keys(files).length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(listing.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, listing, eocd]);
}

const BUILD_PACKAGE = zip({ "manifest.json": Buffer.from(MANIFEST), "images/icon-128.png": NEW_ICON });

function writeIcon(root: string, dir: string, icon: Buffer): void {
  fs.mkdirSync(path.join(root, dir, "images"), { recursive: true });
  fs.writeFileSync(path.join(root, dir, "manifest.json"), MANIFEST);
  fs.writeFileSync(path.join(root, dir, "images", "icon-128.png"), icon);
}

function project(options: { dist?: Buffer | null; source?: Buffer | null; git?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-listing-icon-"));
  fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);
  if (options.source !== null) writeIcon(root, "src", options.source ?? NEW_ICON);

  if (options.dist !== null) {
    for (const browser of ["chrome", "edge", "firefox"]) writeIcon(root, path.join("dist", browser), options.dist ?? OLD_ICON);
  }

  if (options.git !== false) {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "icon");
  }

  return root;
}

function headSha(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function commitFiles(root: string, files: Record<string, string>, message: string): string {
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }

  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
  git("add", ".");
  git("commit", "-q", "-m", message);

  return headSha(root);
}

describe("the zip entry read", () => {
  it("reads one named entry out of a stored archive and names an absent one", () => {
    const limits = { maxEntries: 10, maxBytes: 1024 };
    const manifest = readZipEntry(BUILD_PACKAGE, "manifest.json", limits);
    const icon = readZipEntry(BUILD_PACKAGE, "./images/icon-128.png", limits);
    const absent = readZipEntry(BUILD_PACKAGE, "images/icon-16.png", limits);

    expect(manifest.ok && manifest.data.toString("utf8")).toBe(MANIFEST);
    expect(icon.ok && icon.data.equals(NEW_ICON)).toBe(true);
    expect(absent).toEqual({ ok: false, message: "the archive has no images/icon-16.png", absent: true });
  });
});

describe("the local icon read", () => {
  it("takes the dist icon when it matches the source, the source icon with no dist, and withholds a dist older than the source", () => {
    if (process.platform === "win32") return;

    const current = localIcon(project({ dist: NEW_ICON, git: false }), "edge");
    const sourceOnly = localIcon(project({ dist: null, git: false }), "edge");
    const stale = localIcon(project({ git: false }), "edge");
    const noSource = localIcon(project({ source: null, git: false }), "firefox");

    expect("icon" in current && current.origin).toEqual({ from: "dist", file: "dist/edge/images/icon-128.png" });
    expect("icon" in sourceOnly && sourceOnly.origin).toEqual({ from: "source", file: "src/images/icon-128.png" });
    expect("icon" in sourceOnly && sourceOnly.icon.bytes?.equals(NEW_ICON)).toBe(true);
    expect(stale).toEqual({
      missing: "dist/edge is older than src/images/icon-128.png; run a build first (extension_build), or push the commit so the platform builds it",
      stale: { dist: "dist/edge", source: "src/images/icon-128.png" },
    });

    expect("icon" in noSource && noSource.origin).toEqual({ from: "dist", file: "dist/firefox/images/icon-128.png" });

    const local = readLocalListing(project({ git: false }), "edge");

    expect("problem" in local).toBe(false);
    expect(!("problem" in local) && local.patch.icons).toBeUndefined();
    expect(!("problem" in local) && local.iconStale).toEqual({ dist: "dist/edge", source: "src/images/icon-128.png" });
  });
});
