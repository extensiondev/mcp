import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handler as analyze } from "../tools/analyze";
import { writeEmittedManifest } from "./fixtures/emitted-manifest";

const SIDEBAR_SOURCE = {
  manifest_version: 3,
  name: "Sidebar",
  version: "1.0.0",
  "chromium:background": { service_worker: "background/service_worker.js" },
  "firefox:background": { scripts: ["background/scripts.js"] },
  "chromium:action": { default_title: "Open" },
  "firefox:browser_action": { default_title: "Open" },
  "chromium:side_panel": { default_path: "sidebar/index.html" },
  "firefox:sidebar_action": { default_panel: "sidebar/index.html" },
  "chromium:permissions": ["sidePanel", "storage"],
  "firefox:permissions": ["storage"],
  host_permissions: ["https://example.com/*"],
  "firefox:browser_specific_settings": { gecko: { id: "sidebar@example.com" } },
};

const dirs: string[] = [];

function project(source: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-analyze-by-browser-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify(source));

  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_analyze answers the emitted manifest of every built browser", () => {
  it("carries each browser's emitted manifest and names the resolved keys that differ", async () => {
    const dir = project(SIDEBAR_SOURCE);
    const chrome = writeEmittedManifest(dir, "chrome", SIDEBAR_SOURCE);
    const firefox = writeEmittedManifest(dir, "firefox", SIDEBAR_SOURCE);

    const out = JSON.parse(await analyze({ projectPath: dir, browser: "firefox" }));
    const byBrowser = out.value.manifestByBrowser;

    expect(out.ok).toBe(true);
    expect(byBrowser.browsers).toEqual(["chrome", "firefox"]);
    expect(byBrowser.emitted).toEqual({ chrome, firefox });
    expect(byBrowser.resolved.chrome).toMatchObject({
      background: { service_worker: "background/service_worker.js" },
      actionKey: "action",
      sidebarKey: "side_panel",
      permissions: ["sidePanel", "storage"],
      browser_specific_settings: null,
    });

    expect(byBrowser.resolved.firefox).toMatchObject({
      background: { scripts: ["background/scripts.js"] },
      actionKey: "browser_action",
      sidebarKey: "sidebar_action",
      permissions: ["storage"],
      browser_specific_settings: { gecko: { id: "sidebar@example.com" } },
    });

    expect(byBrowser.differences.sort()).toEqual(
      ["actionKey", "background", "browser_specific_settings", "permissions", "sidebarKey"].sort(),
    );

    expect(byBrowser.differences).not.toContain("host_permissions");
  });

  it("reports one browser with no differences when only one was built", async () => {
    const dir = project(SIDEBAR_SOURCE);
    writeEmittedManifest(dir, "chrome", SIDEBAR_SOURCE);

    const out = JSON.parse(await analyze({ projectPath: dir }));

    expect(out.value.manifestByBrowser.browsers).toEqual(["chrome"]);
    expect(out.value.manifestByBrowser.differences).toEqual([]);
  });

  it("names, per browser, the source permissions the build dropped", async () => {
    const source = { manifest_version: 3, name: "P", version: "1.0.0", permissions: ["storage", "tabs"] };
    const dir = project(source);
    writeEmittedManifest(dir, "chrome", { ...source, permissions: ["storage"] });
    writeEmittedManifest(dir, "firefox", source);

    const out = JSON.parse(await analyze({ projectPath: dir }));

    expect(out.value.manifestByBrowser.sourceDivergence.chrome.join(" ")).toContain("drops permissions: tabs");
    expect(out.value.manifestByBrowser.sourceDivergence.firefox).toBeUndefined();
  });
});
