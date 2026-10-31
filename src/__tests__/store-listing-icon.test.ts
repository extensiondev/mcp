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

import { localIcon } from "../lib/store-listing-icon";
import { readZipEntry } from "../lib/zip-entries";
import { readLocalListing } from "../tools/store-listing";
import { handler as submit } from "../tools/submit";
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
    expect("icon" in sourceOnly && sourceOnly.icon.bytes.equals(NEW_ICON)).toBe(true);
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

describe("extension_submit sync-listing reads each store's icon from the build the store receives", () => {
  const platform = useProjectRoutes("extdev-listing-icon-");
  const sent: Record<string, Record<string, unknown>> = {};

  beforeEach(() => {
    for (const store of Object.keys(sent)) delete sent[store];

    platform.login();

    for (const store of ["edge", "firefox", "chrome"]) {
      platform.routes[`PUT ${LISTING(store)}`] = (call) => {
        sent[store] = call.body;

        return call.body.media?.icons?.length
          ? { body: { ok: true, store, changes: ["icons: e4804a96 -> fed971ed"] } }
          : { status: 409, body: { code: "NO_CHANGE", message: "Nothing changed." } };
      };

      platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: { checks: [] } });
    }
  });

  it("takes the icon from the platform build of the checked out commit, whatever the local dist holds, and names the build", async () => {
    if (process.platform === "win32") return;

    const root = project();
    const head = headSha(root);

    platform.routes[`GET ${BUILDS}`] = () => ({
      body: { items: [{ buildId: HEAD_BUILD, commit: head, status: "success" }, { buildId: OLDER_BUILD, commit: "e".repeat(40), status: "success" }] },
    });

    platform.routes[`GET ${PACKAGE(HEAD_BUILD, "chrome.zip")}`] = () => ({ body: null, bytes: BUILD_PACKAGE });

    const answer = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge", "firefox"], projectPath: root, api: API }));

    expect(answer.status).toBe("listing-synced");
    expect(answer.value.stores.edge.status).toBe("synced");
    expect(answer.value.stores.edge.icon).toEqual({ from: "build", build: HEAD_BUILD, file: "chrome.zip:images/icon-128.png" });
    expect(answer.value.stores.firefox.icon).toEqual({ from: "build", build: HEAD_BUILD, file: "chrome.zip:images/icon-128.png" });
    expect(Buffer.from((sent.edge!.media as any).icons[0].dataBase64, "base64").equals(NEW_ICON)).toBe(true);
    expect(platform.sent("GET", PACKAGE(HEAD_BUILD, "edge.zip"))).toHaveLength(1);
    expect(platform.sent("GET", PACKAGE(HEAD_BUILD, "firefox.zip"))).toHaveLength(1);
    expect(platform.sent("GET", PACKAGE(HEAD_BUILD, "chrome.zip"))).toHaveLength(1);
    expect(platform.sent("GET", PACKAGE(HEAD_BUILD, "chrome.zip"))[0]!.auth).toBe("Bearer claims.sig");
    expect(JSON.stringify(answer)).not.toMatch(/extension-user-land-dev|\/actions\/runs\//);
  });

  it("withholds a dist older than the source when no platform build matches the checked out commit, and answers icon-stale instead of unchanged", async () => {
    if (process.platform === "win32") return;

    const root = project();

    platform.routes[`GET ${BUILDS}`] = () => ({
      body: { items: [{ buildId: HEAD_BUILD, commit: "6".repeat(40), status: "success" }, { buildId: OLDER_BUILD, commit: "e".repeat(40), status: "building" }] },
    });

    const answer = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge"], projectPath: root, api: API }));
    const sentence = `dist/edge is older than src/images/icon-128.png; run a build or pass useBuild: "${HEAD_BUILD}" to take the icon from build ${HEAD_BUILD}`;

    expect(answer.status).toBe("listing-synced");
    expect(answer.value.stores.edge.status).toBe("icon-stale");
    expect(answer.value.stores.edge.icon).toBeUndefined();
    expect(answer.value.stores.edge.iconMissing).toBe(sentence);
    expect(answer.value.stores.edge.filled).not.toContain("icons");
    expect(sent.edge!.media).toBeUndefined();
    expect(answer.value.sayToPerson).toContain(`For edge, ${sentence}.`);
    expect(answer.hint).toContain(sentence);
    expect(platform.calls.some((call) => call.path.includes("/artifacts/"))).toBe(false);
  });

  it("takes the icon from the build useBuild names and refuses a sha that is not a completed platform build", async () => {
    if (process.platform === "win32") return;

    const root = project({ git: false });

    platform.routes[`GET ${BUILDS}`] = () => ({
      body: { items: [{ buildId: OLDER_BUILD, commit: "e".repeat(40), status: "success" }, { buildId: "abc1234", commit: "a".repeat(40), status: "failed" }] },
    });

    platform.routes[`GET ${PACKAGE(OLDER_BUILD, "edge.zip")}`] = () => ({ body: null, bytes: BUILD_PACKAGE });

    const taken = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge"], projectPath: root, useBuild: OLDER_BUILD, api: API }));

    expect(taken.value.stores.edge.icon).toEqual({ from: "build", build: OLDER_BUILD, file: "edge.zip:images/icon-128.png" });
    expect(platform.sent("GET", PACKAGE(OLDER_BUILD, "chrome.zip"))).toHaveLength(0);

    const refused = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge"], projectPath: root, useBuild: "abc1234", api: API }));

    expect(refused.ok).toBe(false);
    expect(refused.error.message).toContain("abc1234 is not a completed platform build of this project");
    expect(platform.sent("PUT", LISTING("edge")).length).toBe(1);
  });

  it("keeps the local icon with the reason when the build's package cannot be read, and sends a current dist as dist", async () => {
    if (process.platform === "win32") return;

    const root = project({ dist: NEW_ICON });
    const head = headSha(root);

    platform.routes[`GET ${BUILDS}`] = () => ({ body: { items: [{ buildId: HEAD_BUILD, commit: head, status: "success" }] } });
    platform.routes[`GET ${PACKAGE(HEAD_BUILD, "chrome.zip")}`] = () => ({ status: 502, body: { code: "REGISTRY_READ_FAILED", message: "The registry could not be read for this build file." } });

    const answer = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome"], projectPath: root, api: API }));

    expect(answer.value.stores.chrome.icon).toEqual({ from: "dist", file: "dist/chrome/images/icon-128.png" });
    expect(answer.value.sayToPerson).toContain(`The icon of build ${HEAD_BUILD} could not be read for chrome (`);
    expect(answer.value.sayToPerson).toContain("; the dist icon was sent instead.");
    expect(Buffer.from((sent.chrome!.media as any).icons[0].dataBase64, "base64").equals(NEW_ICON)).toBe(true);
  });

  it("reads the commit's own build record when the list still says building, and names where every icon came from", async () => {
    if (process.platform === "win32") return;

    const root = project();
    const head = headSha(root);
    let record = "success";

    platform.routes[`GET ${BUILDS}`] = () => ({
      body: { items: [{ buildId: HEAD_BUILD, commit: head, status: "building", conclusion: "success" }, { buildId: OLDER_BUILD, commit: "e".repeat(40), status: "success" }] },
    });

    platform.routes[`GET ${BUILDS}/${HEAD_BUILD}`] = () => ({ body: { buildId: HEAD_BUILD, commit: head, status: record } });
    platform.routes[`GET ${PACKAGE(HEAD_BUILD, "chrome.zip")}`] = () => ({ body: null, bytes: BUILD_PACKAGE });

    const taken = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge", "firefox"], projectPath: root, api: API }));

    expect(taken.value.stores.edge.icon).toEqual({ from: "build", build: HEAD_BUILD, file: "chrome.zip:images/icon-128.png" });
    expect(taken.value.stores.firefox.icon).toEqual({ from: "build", build: HEAD_BUILD, file: "chrome.zip:images/icon-128.png" });
    expect(taken.value.iconSource).toEqual({ from: "build", build: HEAD_BUILD });

    record = "building";

    const current = project({ dist: NEW_ICON });
    const currentHead = headSha(current);

    platform.routes[`GET ${BUILDS}`] = () => ({ body: { items: [{ buildId: HEAD_BUILD, commit: currentHead, status: "building" }] } });
    platform.routes[`GET ${BUILDS}/${HEAD_BUILD}`] = () => ({ body: { buildId: HEAD_BUILD, commit: currentHead, status: record } });

    const local = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge"], projectPath: current, api: API }));
    const reason = `build ${HEAD_BUILD} of the checked out commit is building on the platform, not completed`;

    expect(local.value.stores.edge.icon).toEqual({ from: "dist", file: "dist/edge/images/icon-128.png" });
    expect(local.value.iconSource).toEqual({ from: "local", reason });
    expect(local.value.sayToPerson).toContain(`The edge icon came from the local project, not a platform build: ${reason}.`);
  });

  it("reads the newest build when the push record says the checked out commit changed docs only, and asks for no push", async () => {
    if (process.platform === "win32") return;

    const root = project();
    const head = headSha(root);
    const short = head.slice(0, 7);

    platform.routes[`GET ${BUILDS}`] = () => ({
      body: {
        items: [{ buildId: OLDER_BUILD, commit: "e".repeat(40), status: "success" }],
        lastPush: { commit: head, ref: "main", receivedAt: "2026-10-30T21:11:41.000Z", outcome: "DOCS_ONLY", dispatched: false },
      },
    });

    platform.routes[`GET ${PACKAGE(OLDER_BUILD, "chrome.zip")}`] = () => ({ body: null, bytes: BUILD_PACKAGE });

    const answer = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge"], projectPath: root, api: API }));
    const reason = `the checked out commit ${short} changes docs only; the icon is read from ${OLDER_BUILD}, the newest build, which carries the same package`;

    expect(answer.status).toBe("listing-synced");
    expect(answer.value.stores.edge.status).toBe("synced");
    expect(answer.value.stores.edge.icon).toEqual({ from: "build", build: OLDER_BUILD, file: "chrome.zip:images/icon-128.png" });
    expect(answer.value.iconSource).toEqual({ from: "build", build: OLDER_BUILD, reason });
    expect(JSON.stringify(answer)).not.toMatch(/push it|came from the local project/);
    expect(platform.sent("GET", BUILDS)).toHaveLength(1);
    expect(platform.sent("GET", `${BUILDS}/${short}`)).toHaveLength(0);
  });

  it("names another skip word with what to do, and keeps the push-it sentence when the push record is another commit's", async () => {
    if (process.platform === "win32") return;

    const root = project({ dist: NEW_ICON });
    const head = headSha(root);
    const short = head.slice(0, 7);
    const items = [{ buildId: OLDER_BUILD, commit: "e".repeat(40), status: "success" }];

    platform.routes[`GET ${BUILDS}`] = () => ({ body: { items, lastPush: { commit: head, ref: "main", receivedAt: "2026-10-30T21:11:41.000Z", outcome: "PATH_FILTERED", dispatched: false } } });

    const filtered = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge"], projectPath: root, api: API }));
    const reason = `the checked out commit ${short} was pushed (received 2026-10-30T21:11:41Z) and the platform skipped it as PATH_FILTERED: none of its changed paths touched the project's root directory, so push a change inside it, or run extension_builds {action: "rebuild", buildId: "${short}"} on it; or pass useBuild with a completed build`;

    expect(filtered.value.stores.edge.icon).toEqual({ from: "dist", file: "dist/edge/images/icon-128.png" });
    expect(filtered.value.iconSource).toEqual({ from: "local", reason });
    expect(filtered.value.sayToPerson).toContain(`The edge icon came from the local project, not a platform build: ${reason}.`);
    expect(platform.sent("GET", `${BUILDS}/${short}`)).toHaveLength(0);

    platform.routes[`GET ${BUILDS}`] = () => ({ body: { items, lastPush: { commit: "e".repeat(40), ref: "main", receivedAt: "2026-10-30T21:11:41.000Z", outcome: "DOCS_ONLY", dispatched: false } } });

    const unpushed = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge"], projectPath: root, api: API }));

    expect(unpushed.value.iconSource).toEqual({ from: "local", reason: `the checked out commit ${short} has no platform build; push it, or pass useBuild with a completed build` });
  });

  it("takes the newest build's icon when the local repository proves the checked out commit changed nothing the build reads, and asks for a push once it did", async () => {
    if (process.platform === "win32") return;

    const root = project({ dist: NEW_ICON });
    const built = headSha(root);
    const builtShort = built.slice(0, 7);
    const head = commitFiles(root, { "STORE.md": `${STORE_MD}- Category: Productivity\n` }, "store line");
    const short = head.slice(0, 7);

    platform.routes[`GET ${BUILDS}`] = () => ({ body: { items: [{ buildId: builtShort, commit: built, status: "success" }] } });
    platform.routes[`GET ${PACKAGE(builtShort, "chrome.zip")}`] = () => ({ body: null, bytes: BUILD_PACKAGE });

    const held = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge"], projectPath: root, api: API }));
    const reason = `the checked out commit ${short} changes only STORE.md, which the build does not read, so the icon of build ${builtShort}, the newest build, stands for it and no push is needed`;

    expect(held.status).toBe("listing-synced");
    expect(held.value.stores.edge.icon).toEqual({ from: "build", build: builtShort, file: "chrome.zip:images/icon-128.png" });
    expect(held.value.iconSource).toEqual({ from: "build", build: builtShort, reason });
    expect(JSON.stringify(held)).not.toMatch(/push it|came from the local project/);

    const code = commitFiles(root, { "src/index.ts": "export {};\n" }, "code").slice(0, 7);
    const pushed = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge"], projectPath: root, api: API }));

    expect(pushed.value.stores.edge.icon).toEqual({ from: "dist", file: "dist/edge/images/icon-128.png" });
    expect(pushed.value.iconSource).toEqual({ from: "local", reason: `the checked out commit ${code} has no platform build; push it, or pass useBuild with a completed build` });
  });
});
