import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { firefoxSourceArchiveLine, firefoxSourcesOutcome } from "../lib/firefox-store";
import { approvalVerdict } from "../lib/approval-policy";
import { STORE_SETTINGS_ACTION, modeToPatch, readStoreSettingsChange, requestedLines, storeSettingsDigest } from "../lib/store-settings";
import { submitCheckRefused } from "../lib/submit-action-safety";
import { TOOL_POLICY } from "../lib/tool-policy";
import { validateToolInput } from "../lib/validate-input";
import { schema as submitSchema } from "../tools/submit";
import { schema as submitCheckSchema } from "../tools/submit-check";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const CONFIG = `${PROJECT_ROUTE}/stores/config`;
const APPROVALS = "/api/cli/approvals";
const SETTINGS_PAGE = /\/acme\/widget\/project-settings\/stores$/;

const FIREFOX_PATCH = { enabled: true, sourceArchive: "repository" };

function scopeFor(store: "chrome" | "firefox" | "edge" | "safari", patch: Record<string, unknown>) {
  return { store, settingsDigest: storeSettingsDigest(store, patch) };
}

function approvalRequired(scope: Record<string, string>, fingerprint = actionFingerprint(STORE_SETTINGS_ACTION, scope)) {
  return {
    status: 403,
    body: { code: "APPROVAL_REQUIRED", message: "Needs an owner's approval.", approvalRequest: { action: STORE_SETTINGS_ACTION, scope, fingerprint } },
  };
}

describe("extension_submit configure-store changes a store's settings as a plain call under the owner's token and never takes a credential", () => {
  const platform = useProjectRoutes("extdev-store-configure-");

  it("hashes firstSubmitted last, the bytes the platform hashes, and refuses it off Edge or as anything but a boolean", async () => {
    const { createHash } = await import("node:crypto");
    const platformBytes = JSON.stringify({ store: "edge", settings: { publishAfter: true, firstSubmitted: true } });

    expect(storeSettingsDigest("edge", { firstSubmitted: true, publishAfter: true })).toBe(
      createHash("sha256").update(platformBytes).digest("hex"),
    );

    expect(readStoreSettingsChange("edge", { firstSubmitted: false })).toEqual({ patch: { firstSubmitted: false }, requested: { firstSubmitted: false } });
    expect(readStoreSettingsChange("chrome", { firstSubmitted: true })).toEqual({ problem: '"firstSubmitted" is an edge store setting; chrome does not have it.' });
    expect(readStoreSettingsChange("edge", { firstSubmitted: "yes" })).toEqual({ problem: "storeSettings.firstSubmitted must be true or false." });
  });

  it("hashes dashboardPasted last, the bytes the platform hashes, and refuses it off Chrome or as anything but a boolean", async () => {
    const { createHash } = await import("node:crypto");
    const platformBytes = JSON.stringify({ store: "chrome", settings: { dryRun: false, publisherId: "1a2b3c4d-1a2b-4c3d-8e9f-1a2b3c4d5e6f", dashboardPasted: true } });

    expect(
      storeSettingsDigest("chrome", { dashboardPasted: true, publisherId: "1a2b3c4d-1a2b-4c3d-8e9f-1a2b3c4d5e6f", dryRun: false }),
    ).toBe(createHash("sha256").update(platformBytes).digest("hex"));

    expect(readStoreSettingsChange("chrome", { dashboardPasted: true })).toEqual({ patch: { dashboardPasted: true }, requested: { dashboardPasted: true } });
    expect(readStoreSettingsChange("edge", { dashboardPasted: true })).toEqual({ problem: '"dashboardPasted" is a chrome store setting; edge does not have it.' });
    expect(readStoreSettingsChange("chrome", { dashboardPasted: "yes" })).toEqual({ problem: "storeSettings.dashboardPasted must be true or false." });
  });

  it("takes the version source on any store as the project's one setting, hashes it last, the bytes the platform hashes, and refuses any other word", async () => {
    const { createHash } = await import("node:crypto");
    const platformBytes = JSON.stringify({ store: "firefox", settings: { enabled: true, versionSource: "repo" } });

    expect(storeSettingsDigest("firefox", { versionSource: "repo", enabled: true })).toBe(createHash("sha256").update(platformBytes).digest("hex"));

    for (const store of ["chrome", "firefox", "edge", "safari"] as const) {
      expect(readStoreSettingsChange(store, { versionSource: "Repo" }), store).toEqual({ patch: { versionSource: "repo" }, requested: { versionSource: "repo" } });
    }

    expect(readStoreSettingsChange("chrome", { versionSource: "platform" })).toEqual({ patch: { versionSource: "platform" }, requested: { versionSource: "platform" } });
    expect(readStoreSettingsChange("chrome", { versionSource: "manifest" })).toEqual({ problem: 'storeSettings.versionSource must be platform or repo; got "manifest".' });
    expect(requestedLines("chrome", { enabled: true, versionSource: "repo" })).toEqual(["chrome.enabled: true", 'stores.versionSource: "repo"']);
    expect(submitCheckRefused({ action: "configure-store", store: "chrome", storeSettings: { versionSource: "repo" } })).toBeNull();
    expect(submitCheckRefused({ action: "configure-store", store: "chrome", storeSettings: { enabled: true } })).toContain("asks for one, as does a change of the store version source");
  });

  it("refuses an Edge listing URL without a crx id, a Chrome store URL off the dashboard, and a store URL off Edge and Chrome, before anything is sent", () => {
    expect(readStoreSettingsChange("edge", { storeUrl: "" })).toEqual({ patch: { storeUrl: "" }, requested: { storeUrl: "" } });

    for (const storeUrl of ["https://microsoftedge.microsoft.com/addons/detail/903d21e4-0e5b-4507-95f2-4620fcf06f1c", "https://example.com/addons/detail/abcdefghijklmnopabcdefghijklmnop", 7]) {
      const read = readStoreSettingsChange("edge", { storeUrl });

      expect("problem" in read && read.problem, String(storeUrl)).toMatch(/must be the Edge Add-ons listing URL that ends in the 32-letter crx id/);
    }

    const chrome = readStoreSettingsChange("chrome", { storeUrl: "https://chromewebstore.google.com/detail/abc" });
    const firefox = readStoreSettingsChange("firefox", { storeUrl: "https://addons.mozilla.org/addon/widget" });

    expect("problem" in chrome && chrome.problem).toMatch(/storeUrl for chrome must be the item's address from the Chrome Web Store developer dashboard/);
    expect("problem" in firefox && firefox.problem).toMatch(/"storeUrl", which is a raw platform field/);
  });

  it("810: reads the Chrome ids by the platform's one rule: an item id is never a publisher id, and the dashboard address is chrome.google.com with or without /u/N/", () => {
    const ITEM = "abcdefghijklmnopabcdefghijklmnop";
    const PUBLISHER = "1a2b3c4d-1a2b-4c3d-8e9f-1a2b3c4d5e6f";

    const problemOf = (settings: Record<string, unknown>): string => {
      const read = readStoreSettingsChange("chrome", settings);

      return "problem" in read ? read.problem : "";
    };

    expect(problemOf({ publisherId: ITEM })).toMatch(/^publisherId must be the Chrome Web Store publisher id, the token after \/devconsole\//);
    expect(problemOf({ storeUrl: `https://chrome.google.com/webstore/devconsole/${ITEM}/${ITEM}/edit` })).toMatch(/storeUrl for chrome must be the item's address/);
    expect(problemOf({ chromeItemId: `${ITEM.slice(0, 31)}q` })).toMatch(/^chromeItemId must be the item's 32-letter id/);
    expect(readStoreSettingsChange("chrome", { chromeItemId: ITEM.toUpperCase() })).toMatchObject({ patch: { storeId: ITEM } });
    expect(problemOf({ storeUrl: `https://evil.example/chrome.google.com/webstore/devconsole/${PUBLISHER}/${ITEM}` })).toMatch(/storeUrl for chrome must be the item's address/);
    expect(problemOf({ publisherId: `https://evil.example/webstore/devconsole/${PUBLISHER}` })).toMatch(/^publisherId must be/);

    for (const address of [`https://chrome.google.com/u/1/webstore/devconsole/${PUBLISHER}/${ITEM}/edit`, `chrome.google.com/webstore/devconsole/${PUBLISHER}/${ITEM}?hl=en`]) {
      expect(readStoreSettingsChange("chrome", { storeUrl: address }), address).toMatchObject({ patch: { storeId: ITEM, publisherId: PUBLISHER } });
      expect(readStoreSettingsChange("chrome", { chromeItemId: address }), address).toMatchObject({ patch: { storeId: ITEM } });
    }

    expect(readStoreSettingsChange("chrome", { publisherId: `https://chrome.google.com/u/0/webstore/devconsole/${PUBLISHER}` })).toMatchObject({ patch: { publisherId: PUBLISHER } });
    expect(readStoreSettingsChange("chrome", { publisherId: PUBLISHER, chromeItemId: ITEM })).toMatchObject({ patch: { storeId: ITEM, publisherId: PUBLISHER } });
  });

  it("918: keeps the enabled refusal, since the check tool's schema types storeSettings as a bare object and a mode that may leave a dry run goes to the lane", () => {
    const asked = { action: "configure-store", store: "chrome", storeSettings: { enabled: "yes", submissionMode: "public" } };

    expect(validateToolInput(submitSchema.inputSchema, asked).map((issue) => issue.path)).toEqual(["storeSettings.enabled"]);
    expect(validateToolInput(submitCheckSchema.inputSchema, asked)).toEqual([]);
    expect(submitCheckRefused(asked)).toBeNull();
    expect(readStoreSettingsChange("chrome", asked.storeSettings)).toEqual({ problem: "storeSettings.enabled must be true or false." });
  });

  it("takes the project source archive kind at the schema and the patch, and says what it attaches", () => {
    const asked = { action: "configure-store", store: "firefox", storeSettings: { sourceArchive: "project" } };
    const connectUrl = "https://console.extension.dev/acme/web/settings/stores";
    const check = (actual: string) => ({ checks: [{ id: "store.firefox_source_archive", status: actual === "none" ? "fail" : "pass", actual }] });

    expect(validateToolInput(submitSchema.inputSchema, asked)).toEqual([]);
    expect(readStoreSettingsChange("firefox", { sourceArchive: "project" })).toEqual({ patch: { sourceArchive: "project" }, requested: { sourceArchive: "project" } });
    expect(readStoreSettingsChange("firefox", { sourceArchive: "zip" })).toEqual({ problem: 'storeSettings.sourceArchive must be repository, project or none; got "zip".' });
    expect(firefoxSourcesOutcome(undefined, "project", connectUrl)).toMatchObject({ attached: true, source: "store-setting", say: expect.stringContaining("the project folder plus its workspace packages") });
    expect(firefoxSourceArchiveLine(check("project"), connectUrl)).toContain("attach the project folder plus the workspace packages it uses");
    expect(firefoxSourceArchiveLine(check("none"), connectUrl)).toContain('sourceArchive:"project"');
  });

  it("writes a mode id as every field the platform derives it from", () => {
    expect(modeToPatch("chrome", "draft-until-public")).toEqual({ dryRun: false, skipPublish: null, stagedPublish: false });
    expect(modeToPatch("chrome", "draft")).toEqual({ dryRun: false, skipPublish: true, stagedPublish: false });
    expect(modeToPatch("chrome", "public")).toEqual({ dryRun: false, skipPublish: false, stagedPublish: false });
    expect(modeToPatch("chrome", "staged")).toEqual({ dryRun: false, skipPublish: null, stagedPublish: true });
    expect(modeToPatch("edge", "review")).toEqual({ dryRun: false, publishAfter: true });
    expect(modeToPatch("edge", "draft")).toEqual({ dryRun: false, publishAfter: false });
    expect(modeToPatch("firefox", "listed")).toEqual({ dryRun: false, releaseChannel: "listed" });
    expect(modeToPatch("safari", "draft")).toEqual({ dryRun: false, publishAfter: false });
    expect(modeToPatch("safari", "review")).toEqual({ dryRun: false, publishAfter: true });
    expect(modeToPatch("safari", "dry-run")).toEqual({ dryRun: true });

    const read = readStoreSettingsChange("firefox", { enabled: true, submissionMode: "listed", sourceArchive: "repository" });

    expect(read).toEqual({
      patch: { enabled: true, dryRun: false, releaseChannel: "listed", sourceArchive: "repository" },
      requested: { enabled: true, submissionMode: "listed", sourceArchive: "repository" },
    });

    expect(storeSettingsDigest("firefox", { sourceArchive: "repository", enabled: true })).toBe(storeSettingsDigest("firefox", { enabled: true, sourceArchive: "repository" }));
    expect(storeSettingsDigest("firefox", { enabled: true })).not.toBe(storeSettingsDigest("chrome", { enabled: true }));
  });
});
