// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators


import { describe, expect, it } from "vitest";

import { firefoxUpdateManifestOutcome, updateManifestOf, updateManifestServedSentence, updateUrlOfCheck } from "../lib/firefox-update-url";
import { updateManifestAddress } from "../lib/package-address";
import { toSubmission } from "../lib/platform-submissions";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

type Row = Record<string, unknown>;

const PREFLIGHT = `${PROJECT_ROUTE}/stores/firefox/submissions/preflight`;
const UPDATES = updateManifestAddress({ workspace: "acme", project: "widget" }, "stable", API);
const CHECKED = "2026-10-31T12:00:00.000Z";
const PLATFORM_PASS = `Firefox will look for updates of this self-distributed version at ${UPDATES}, the manifest the platform serves for the stable channel with every signed version.`;
const NOT_SERVED = `The update manifest at ${UPDATES} is not served yet: no signed build is on that channel yet; the platform serves it once AMO signs the version, whatever the channel's audience, with no step for you.`;
const SERVED = `Firefox finds updates at ${UPDATES}, served now (checked ${CHECKED}).`;
const OWNER_STEP = /console|promote a build|make the .* public/i;

function check(id: string, status: string, message: string): Row {
  return { id, status, severity: "blocking", stage: "integration", ownership: "automated", message };
}

function report(updateCheck: Row, updateManifest: Row): Row {
  const checks = [
    check("store.enabled", "pass", "Store publishing is on."),
    check("store.config_present", "pass", "Store configuration is present."),
    check("store.credentials_present", "pass", "Store credentials are saved."),
    updateCheck,
  ];

  return {
    store: "firefox",
    summary: { pass: checks.length, warn: 0, fail: 0, blockingFailures: 0, canSubmit: true },
    submissionMode: { id: "unlisted", label: "Unlisted", description: "Signed for self distribution." },
    connection: { kind: "api-key", connectedAs: "cezar@example.com", healthy: true, itemId: "widget@acme.example", itemLinked: true },
    checks,
    firefoxPreflight: { act: "upload", checks: [updateCheck], blocking: [], warnings: [], lock: null, nextVersion: "0.1.0.1", channel: "unlisted", updateManifest },
  };
}

describe("the Firefox preflight says whether the update manifest is served, from the platform's one GET", () => {
  const platform = useProjectRoutes("extdev-update-served-");

  it("says not served yet with the reason and what the platform does about it, never a step for the owner", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: report(
        { ...check("firefox.update_url", "fail", PLATFORM_PASS), severity: "warn", stage: "review" },
        { url: UPDATES, channel: "stable", audience: "private", served: false, reason: "channel-not-public", checkedAt: CHECKED },
      ),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "8467b5b", api: API }));
    const view = out.value.stores.firefox.updateManifest;

    expect(out.status).toBe("preflight-read");
    expect(view).toMatchObject({ updateManifestUrl: UPDATES, served: false, reason: "channel-not-public", checkedAt: CHECKED });
    expect(view.say).toContain(NOT_SERVED);
    expect(view.say).not.toMatch(OWNER_STEP);
    expect(out.hint).toContain(NOT_SERVED);
  });

  it("says served now with the time it was checked, once", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: report(
        { ...check("firefox.update_url", "pass", PLATFORM_PASS), severity: "warn", stage: "review" },
        { url: UPDATES, channel: "stable", audience: "private", served: true, reason: null, checkedAt: CHECKED },
      ),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "8467b5b", api: API }));
    const view = out.value.stores.firefox.updateManifest;

    expect(view).toMatchObject({ served: true, checkedAt: CHECKED });
    expect(view.reason).toBeUndefined();
    expect(view.say).toContain(SERVED);
    expect(view.say.match(/served now/g)).toHaveLength(1);
    expect(out.hint).toContain(SERVED);
  });

  it("keeps the platform's own served words verbatim when its check already carries them", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: report(
        { ...check("firefox.update_url", "pass", `${PLATFORM_PASS} It is served now (checked ${CHECKED}).`), severity: "warn", stage: "review" },
        { url: UPDATES, channel: "stable", audience: "private", served: true, reason: null, checkedAt: CHECKED },
      ),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "8467b5b", api: API }));
    const view = out.value.stores.firefox.updateManifest;

    expect(view.say).toBe(`${PLATFORM_PASS} It is served now (checked ${CHECKED}).`);
    expect(view.say.match(/served now/g)).toHaveLength(1);
    expect(view.served).toBe(true);
  });

  it("says nothing about serving when the platform did not read the address", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: report({ ...check("firefox.update_url", "pass", PLATFORM_PASS), severity: "warn", stage: "review" }, { url: UPDATES, channel: "stable", audience: "private" }),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "8467b5b", api: API }));
    const view = out.value.stores.firefox.updateManifest;

    expect(view.served).toBeUndefined();
    expect(view.say).not.toMatch(/served now|not served yet/);
  });
});

describe("the submit answer carries the update manifest the platform proved", () => {
  const platform = useProjectRoutes("extdev-update-served-submit-");

  it("says Firefox finds updates at the address, served now, and names the pin the platform made", async () => {
    if (process.platform === "win32") return;

    platform.login();

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";

    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: report({ ...check("firefox.update_url", "pass", PLATFORM_PASS), severity: "warn", stage: "review" }, { url: UPDATES, channel: "stable", audience: "private" }),
    });

    platform.routes["POST /api/cli/stores/submit"] = () => ({
      body: {
        ok: true,
        projectId: "prj_probe",
        buildId: "8467b5b",
        submissions: [{ id: "sub-1", store: "firefox", status: "pending", updateManifest: { url: UPDATES, channel: "stable", served: false, reason: "channel-not-public", checkedAt: CHECKED } }],
        origin: "mcp",
      },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: {
        submissions: [
          {
            id: "sub-1",
            store: "firefox",
            status: "signed",
            buildId: "8467b5b",
            amoChannel: "unlisted",
            updateManifest: {
              url: UPDATES,
              channel: "stable",
              namedByPackage: true,
              served: true,
              checkedAt: CHECKED,
              pinned: { channel: "stable", buildId: "8467b5b", pinnedAt: CHECKED },
            },
          },
        ],
      },
    });

    const out = JSON.parse(await submit({ browsers: ["firefox"], buildSha: "8467b5b", dryRun: false, api: API }));

    expect(out.status).toBe("submitted");
    expect(out.value.firefoxUpdateManifest).toMatchObject({ url: UPDATES, served: true, checkedAt: CHECKED, pinned: { channel: "stable", buildId: "8467b5b" } });
    expect(out.value.firefoxUpdateManifest.say).toBe(`${SERVED} The platform pinned build 8467b5b to the stable channel for Firefox; the manifest lists it within a minute.`);
    expect(out.value.firefoxUpdateManifest.say).not.toMatch(OWNER_STEP);
    expect(out.hint).toContain(out.value.firefoxUpdateManifest.say);
    expect(out.hint).not.toMatch(/promote a build|make the .* public/i);
  });

  it("falls back to the dispatch answer's row when the record carries no update manifest yet", async () => {
    if (process.platform === "win32") return;

    platform.login();

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";

    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: report({ ...check("firefox.update_url", "pass", PLATFORM_PASS), severity: "warn", stage: "review" }, { url: UPDATES, channel: "stable", audience: "private" }),
    });

    platform.routes["POST /api/cli/stores/submit"] = () => ({
      body: {
        ok: true,
        projectId: "prj_probe",
        buildId: "8467b5b",
        submissions: [{ id: "sub-1", store: "firefox", status: "pending", updateManifest: { url: UPDATES, channel: "stable", served: false, reason: "channel-not-public", checkedAt: CHECKED } }],
        origin: "mcp",
      },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: "sub-1", store: "firefox", status: "submitted", buildId: "8467b5b" }] },
    });

    const out = JSON.parse(await submit({ browsers: ["firefox"], buildSha: "8467b5b", dryRun: false, api: API }));

    expect(out.status).toBe("submitted");
    expect(out.value.firefoxUpdateManifest).toMatchObject({ url: UPDATES, served: false, reason: "channel-not-public" });
    expect(out.value.firefoxUpdateManifest.say).toBe(NOT_SERVED);
    expect(out.hint).toContain(NOT_SERVED);
  });
});

describe("the served sentence and its readers", () => {
  it("reads the address out of the platform's pass text when a comma or a period follows it", () => {
    expect(updateUrlOfCheck({ message: PLATFORM_PASS })).toBe(UPDATES);
    expect(updateUrlOfCheck({ message: `Firefox will look for updates of this self-distributed version at ${UPDATES}.` })).toBe(UPDATES);
    expect(updateUrlOfCheck({ message: `Firefox will look for updates of this self-distributed version at ${UPDATES}` })).toBe(UPDATES);
  });

  it("names the route's reason codes in plain words and never the refusal body", () => {
    expect(updateManifestServedSentence({ url: UPDATES, served: false, reason: "no-gecko-id" })).toContain("carry no browser_specific_settings.gecko.id");
    expect(updateManifestServedSentence({ url: UPDATES, served: false, reason: "unreachable" })).toContain("the address could not be read");
    expect(updateManifestServedSentence({ url: UPDATES, served: false, reason: "503" })).toContain("the address answered 503");
    expect(updateManifestServedSentence({ url: UPDATES, served: false })).toContain("the address did not answer 200");
    expect(updateManifestServedSentence({ url: UPDATES, served: true })).toBe(`Firefox finds updates at ${UPDATES}, served now.`);
  });

  it("reads a platform block only when it names the address and a boolean served, and the submission row through toSubmission", () => {
    expect(updateManifestOf({ url: UPDATES, served: true, checkedAt: CHECKED })).toEqual({ url: UPDATES, served: true, checkedAt: CHECKED, say: SERVED });
    expect(updateManifestOf({ url: UPDATES })).toBeUndefined();
    expect(updateManifestOf({ served: true })).toBeUndefined();
    expect(updateManifestOf(null)).toBeUndefined();

    const row = toSubmission({ store: "firefox", id: "sub-1", updateManifest: { url: UPDATES, served: false, reason: "channel-not-public" } });

    expect(row?.updateManifest).toMatchObject({ url: UPDATES, served: false, reason: "channel-not-public", say: NOT_SERVED });
    expect(toSubmission({ store: "chrome", id: "sub-2" })?.updateManifest).toBeUndefined();

    expect(firefoxUpdateManifestOutcome(undefined, [{ store: "chrome" }, { store: "firefox", updateManifest: { url: UPDATES, served: true } }])?.say).toBe(
      `Firefox finds updates at ${UPDATES}, served now.`,
    );

    expect(firefoxUpdateManifestOutcome(undefined, [{ store: "chrome" }])).toBeNull();
  });
});
