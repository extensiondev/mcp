import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as manifestValidate from "../tools/manifest-validate";


let projectDir: string;

function write(rel: string, contents: string) {
  const full = path.join(projectDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-companion-"));
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

    const blame = [
      ...(parsed.value.errors ?? []),
      ...(parsed.value.warnings ?? []),
    ].join("\n");
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
    expect(parsed.value.buildBlocking).toBeFalsy();
  });

  it("still blames the root manifest for the USER's own undeclared calls", async () => {
    write("src/background.js", "chrome.bookmarks.getTree();");

    const parsed = JSON.parse(
      await manifestValidate.handler({ projectPath: projectDir }),
    );

    const blame = [
      ...(parsed.value.errors ?? []),
      ...(parsed.value.warnings ?? []),
    ].join("\n");
    expect(blame).toContain("chrome.bookmarks");
  });
});
