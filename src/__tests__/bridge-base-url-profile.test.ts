import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import { envelope } from "../lib/envelope";

import type * as ActModule from "../lib/act";

let relayReply: () => string = () =>
  envelope({
    ok: false,
    command: "extension_open",
    status: "failed",
    error: { code: "E_EVAL", name: "EvalError", message: "call to eval() blocked by CSP" },
  });
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return { ...actual, runActVerb: async () => relayReply() };
});

const bridge = await import("../lib/bridge-tabs");

const dirs: string[] = [];

function project(options: { addonId?: string | null; uuid?: string; prefsFor?: string } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-bridge-base-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", "firefox");
  fs.mkdirSync(dist, { recursive: true });
  const manifest: Record<string, unknown> = { manifest_version: 3, name: "F" };

  if (options.addonId !== null) {
    manifest.browser_specific_settings = { gecko: { id: options.addonId ?? "redux@example.org" } };
  }

  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest));
  const profile = path.join(dir, "dist", "extension-profile-firefox");
  fs.mkdirSync(profile, { recursive: true });
  const map = { "formautofill@mozilla.org": "a171fa26-9fb9-4cb3-90d7-681b47971d4a", [options.prefsFor ?? "redux@example.org"]: options.uuid ?? "a3086c53-36a0-4996-ba4b-4538e5aef853" };
  const escaped = JSON.stringify(map).replace(/"/g, '\\"');
  fs.writeFileSync(
    path.join(profile, "prefs.js"),
    `user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("extensions.webextensions.uuids", "${escaped}");\n`,
  );

  const readyDir = path.join(dir, "dist", "extension-js", "firefox");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify({ status: "ready", profilePath: profile }));

  return dir;
}

afterEach(() => {
  relayReply = () =>
    envelope({
      ok: false,
      command: "extension_open",
      status: "failed",
      error: { code: "E_EVAL", name: "EvalError", message: "call to eval() blocked by CSP" },
    });

  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("the moz-extension base is read off the profile when the background refuses the eval", () => {
  it("maps the built manifest's gecko id through extensions.webextensions.uuids", async () => {
    const dir = project();

    expect(await bridge.resolveBridgeBaseUrl(dir, "firefox")).toBe(
      "moz-extension://a3086c53-36a0-4996-ba4b-4538e5aef853/",
    );

    expect(bridge.geckoAddonId(dir, "firefox")).toBe("redux@example.org");
  });

  it("prefers the relay's answer when the background does evaluate", async () => {
    const dir = project();
    relayReply = () =>
      envelope({ ok: true, command: "extension_open", status: "ok", value: "moz-extension://from-relay" });

    expect(await bridge.resolveBridgeBaseUrl(dir, "firefox")).toBe("moz-extension://from-relay/");
  });

  it("answers null when the manifest declares no add-on id or the profile does not list it", async () => {
    expect(await bridge.resolveBridgeBaseUrl(project({ addonId: null }), "firefox")).toBeNull();
    expect(await bridge.resolveBridgeBaseUrl(project({ prefsFor: "other@example.org" }), "firefox")).toBeNull();
  });
});
