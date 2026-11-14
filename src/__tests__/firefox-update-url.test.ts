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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { channelXpiAddress, namesRegistryOrToken, updateManifestAddress } from "../lib/package-address";
import { manifestUpdateUrlOf } from "../lib/store-facts-local";
import { handler as publish } from "../tools/publish";
import { handler as promote } from "../tools/release-promote";
import { storeMdNamedForPerson } from "../lib/store-md-words";
import { promoteAnswer, publishAnswer } from "./fixtures/platform-answers";

type Row = Record<string, unknown>;

const PROD = "https://www.extension.dev";
const PROJECT_ID = "prj_308";
const REF = { workspace: "acme", project: "widget" };
const UPDATES = "https://acme.extension.dev/widget/channels/stable/updates.json";
const XPI = "https://acme.extension.dev/widget/channels/stable/firefox.xpi";
const OTHER = "https://example.com/updates.json";
const OLD_WARNING =
  "This unlisted version sets no browser_specific_settings.gecko.update_url, so Firefox will not find its updates. Point update_url at an https update manifest you host, or distribute on the listed channel.";
const DO_IT_YOURSELF = /you host|host an update manifest|host it yourself/i;

function updateCheck(message: string, status = "warn"): Row {
  return { id: "firefox.update_url", label: "Update manifest", status, severity: "warning", stage: "review", message };
}

function firefoxReport(checks: Row[], warnings: string[] = checks.map((check) => String(check.id))): Row {
  return {
    store: "firefox",
    summary: { pass: 9, warn: warnings.length, fail: 0, canSubmit: true },
    checks,
    connection: { kind: "api-key", connectedAs: "cezar@example.com", healthy: true, itemId: "widget@acme.example", itemLinked: true },
    submissionMode: { id: "unlisted", label: "Unlisted", description: "Firefox versions will upload to the unlisted channel for limited distribution." },
    firefoxPreflight: { act: "upload", checks, blocking: [], warnings, lock: null, nextVersion: "0.1.0.1", channel: "unlisted" },
  };
}

describe("the Firefox update manifest address is built beside the package address", () => {
  it("names updates.json and firefox.xpi under the channel on the project's own domain, token-free", () => {
    expect(updateManifestAddress(REF, "stable", PROD)).toBe(UPDATES);
    expect(channelXpiAddress(REF, "stable", PROD)).toBe(XPI);
    expect(updateManifestAddress(REF, "beta", PROD)).toBe("https://acme.extension.dev/widget/channels/beta/updates.json");
    expect(updateManifestAddress(null, "stable", PROD)).toBe("");
    expect(updateManifestAddress(REF, "", PROD)).toBe("");
    expect(namesRegistryOrToken(UPDATES + XPI)).toEqual([]);
  });

  it("reads the manifest's gecko update_url for the firefox target", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-update-url-manifest-"));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name: "Widget", version: "0.1.0", manifest_version: 3, browser_specific_settings: { gecko: { id: "widget@acme.example", update_url: OTHER } } }));

    expect(manifestUpdateUrlOf(dir)).toBe(OTHER);
    expect(manifestUpdateUrlOf("")).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the update_url under the firefox: and gecko: prefixed key shapes of an unfolded manifest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-update-url-prefixed-"));
    fs.mkdirSync(path.join(dir, "dist", "firefox"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "dist", "firefox", "manifest.json"),
      JSON.stringify({ name: "Widget", version: "0.1.0", manifest_version: 3, "gecko:browser_specific_settings": { "firefox:gecko": { id: "widget@acme.example", "gecko:update_url": UPDATES } } }),
    );

    expect(manifestUpdateUrlOf(dir)).toBe(UPDATES);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
