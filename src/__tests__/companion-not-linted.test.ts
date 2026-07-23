import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as manifestValidate from "../tools/manifest-validate";

// A companion extension under ./extensions is a SEPARATE extension with its
// own manifest. Its API usage must never be linted against the root manifest.
//
// Regression pin for the trace-swarm's most release-dangerous finding: one
// `extension_dev carrier: true` drops the live-preview carrier into
// ./extensions, the carrier calls chrome.bookmarks/history/cookies/topSites/
// webNavigation/downloads because it holds every permission, and every later
// extension_build was refused with six buildBlocking errors that the user's
// own code could not possibly have caused. Reproduced live before the fix.
//
// Following reports-failure.test.ts discipline: the assertions below must fail
// if the exclusion is removed, so break scanApiUsage's `excluded` argument to
// verify this test still has teeth.

let projectDir: string;

function write(rel: string, contents: string) {
  const full = path.join(projectDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-companion-"));
  // The user's own extension: innocent, declares nothing exotic.
  write(
    "src/manifest.json",
    JSON.stringify({
      manifest_version: 3,
      name: "innocent",
      version: "1.0.0",
      action: {},
    }),
  );
  write("src/background.js", "chrome.runtime.onInstalled.addListener(() => {});");
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("companion extensions are not linted against the root manifest", () => {
  it("does not blame the root manifest for a companion's permission-gated calls", async () => {
    // A companion with its own manifest, calling everything the carrier calls.
    write(
      "extensions/extension-dev-live-preview/manifest.json",
      JSON.stringify({
        manifest_version: 3,
        name: "companion",
        version: "1.0.0",
        permissions: ["bookmarks", "history", "cookies", "downloads"],
      }),
    );
    write(
      "extensions/extension-dev-live-preview/background/service_worker.js",
      [
        "chrome.bookmarks.getTree();",
        "chrome.history.search({});",
        "chrome.cookies.getAll({});",
        "chrome.topSites.get();",
        "chrome.webNavigation.onCommitted.addListener(() => {});",
        "chrome.downloads.search({});",
      ].join("\n"),
    );

    const parsed = JSON.parse(
      await manifestValidate.handler({ projectPath: projectDir }),
    );

    const blame = [...(parsed.errors ?? []), ...(parsed.warnings ?? [])].join(
      "\n",
    );
    for (const api of [
      "bookmarks",
      "history",
      "cookies",
      "topSites",
      "webNavigation",
      "downloads",
    ]) {
      expect(blame).not.toContain(`chrome.${api}`);
    }
    expect(parsed.buildBlocking).toBeFalsy();
  });

  it("still blames the root manifest for the USER's own undeclared calls", async () => {
    // The exclusion must not become a blanket amnesty: same API, but in the
    // user's own source, must still be reported.
    write("src/background.js", "chrome.bookmarks.getTree();");

    const parsed = JSON.parse(
      await manifestValidate.handler({ projectPath: projectDir }),
    );

    const blame = [...(parsed.errors ?? []), ...(parsed.warnings ?? [])].join(
      "\n",
    );
    expect(blame).toContain("chrome.bookmarks");
  });
});
