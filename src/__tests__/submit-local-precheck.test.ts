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

import { describe, expect, it } from "vitest";

import { buildSummaryPath } from "../lib/session-paths";
import { REVIEWER_NOTE_TOOLCHAIN_CHECK, reviewerNoteBuildLine, toolchainDifferences, toolchainSentence } from "../lib/store-md-toolchain";
import { WRITE_FAILURE_REPORT_URL } from "../lib/settings-write";
import { FIREFOX_LISTING_CHECK, SAFARI_DESCRIPTION_CHECK, SAFARI_DESCRIPTION_MAX } from "../lib/store-preflight-local";
import { PLATFORM_UNAVAILABLE_SENTENCE, PLATFORM_UNAVAILABLE_STATUS, STORE_RUN_CHECK, storeRunUnavailable } from "../lib/store-run-unavailable";
import { LOCAL_CHECK_FAILED_STATE, SAFARI_DESCRIPTION_UNCHECKED } from "../lib/submit-local-precheck";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

type Row = Record<string, any>;

const SHA = "6fb8b3e";
const APPROVALS = "/api/cli/approvals";
const DISPATCH = "/api/cli/stores/submit";
const PREFLIGHT = (store: string) => `POST ${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const LISTING = (store: string) => `GET ${PROJECT_ROUTE}/stores/${store}/listing`;
const BUILD = `GET ${PROJECT_ROUTE}/builds/${SHA}`;
const SETTINGS = `GET ${PROJECT_ROUTE}/settings/build`;

const NO_STORE_RUN = "No store submission workflow (the store run) found on the project's build environment";
const LANE_NOT_TAKING = "Store submissions for this project run on the build lane, which is not taking them yet. Nothing was sent to the store, and your approval was not spent.";
const ON_FILE = { store: "firefox", listing: { title: "Widget" }, media: {}, updatedAt: "2026-11-06T23:19:00.000Z" };

const said = (out: Row): string => JSON.stringify(out, (key, value) => (key === "platformLine" ? undefined : value));

const CONNECTED: Record<string, Row> = {
  safari: { kind: "app-store-connect", connectedAs: "Visionario", healthy: true, itemId: "6749000000", itemLinked: true },
  firefox: { kind: "amo", connectedAs: "visionario", healthy: true, itemId: "{a1b2}", itemLinked: true },
};

function report(store: string): Row {
  return { store, summary: { pass: 1, warn: 0, fail: 0, blockingFailures: 0, canSubmit: true }, checks: [], connection: CONNECTED[store] };
}

function project(description: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-463b-"));

  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "widget" }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Widget", version: "0.1.0", description }));

  return root;
}

describe("a real submit runs the preflight's two local checks before the approval ask (ledger 463)", () => {
  const platform = useProjectRoutes("extdev-463b-submit-");

  function stores(...names: string[]): void {
    platform.login();
    for (const store of names) platform.routes[PREFLIGHT(store)] = () => ({ body: report(store) });
    platform.routes[SETTINGS] = () => ({ body: { enabledBrowsers: { chrome: true, edge: true, firefox: true, safari: true } } });
    platform.routes[BUILD] = () => ({ body: { id: SHA, status: "success", browsers: ["chrome", "edge", "firefox", "safari"].map((name) => ({ name, status: "success" })) } });
    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_463b", approvalUrl: `${API}/device/approve/apr_463b` } });
  }

  async function real(browsers: string[], extra: Row = {}): Promise<Row> {
    return JSON.parse(await submit({ action: "submit", browsers, buildSha: SHA, dryRun: false, api: API, ...extra }));
  }

  async function preflightIds(store: string, extra: Row = {}): Promise<string[]> {
    const out = JSON.parse(await submit({ action: "preflight", browsers: [store], buildSha: SHA, api: API, ...extra }));

    return (out.value.stores[store].failing as Row[]).map((row) => row.id);
  }

  it(`refuses a Safari submit whose description is ${SAFARI_DESCRIPTION_MAX + 1} characters before any approval POST, with the preflight's check`, async () => {
    stores("safari");
    const projectPath = project("d".repeat(SAFARI_DESCRIPTION_MAX + 1));

    const out = await real(["safari"], { projectPath });

    expect(out.ok).toBe(false);
    expect(out.status).toBe(LOCAL_CHECK_FAILED_STATE);
    expect(out.error.checkId).toBe(SAFARI_DESCRIPTION_CHECK);
    expect(out.error.message).toContain("90849");
    expect(out.error.message).toContain("no approval was asked for");
    expect(out.value.refusedBeforeApproval).toBe(true);
    expect(out.value.failing[0]).toMatchObject({ store: "safari", id: SAFARI_DESCRIPTION_CHECK, status: "fail", severity: "blocking" });
    expect(out.value.nextStep.kind).toBe("resubmit");
    expect(out.hint).toContain(`Shorten the description to ${SAFARI_DESCRIPTION_MAX} characters or fewer`);
    expect(await preflightIds("safari", { projectPath })).toContain(out.error.checkId);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(platform.sent("POST", DISPATCH)).toHaveLength(0);
  });

  it("refuses a Firefox submit with no listing on file before any approval POST, naming sync-listing, with one listing read", async () => {
    stores("firefox");
    platform.routes[LISTING("firefox")] = () => ({ body: { store: "firefox", listing: {}, media: {}, updatedAt: null } });

    const out = await real(["firefox"]);

    expect(out.ok).toBe(false);
    expect(out.status).toBe(LOCAL_CHECK_FAILED_STATE);
    expect(out.error.checkId).toBe(FIREFOX_LISTING_CHECK);
    expect(out.value.nextStep.kind).toBe("sync-listing");
    expect(out.hint).toContain('extension_submit {action: "sync-listing", store: "firefox"');
    expect(platform.sent("GET", `${PROJECT_ROUTE}/stores/firefox/listing`)).toHaveLength(1);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(platform.sent("POST", DISPATCH)).toHaveLength(0);
    expect(await preflightIds("firefox")).toContain(out.error.checkId);
  });

  it("asks for the approval when the description fits and the Firefox listing is on file", async () => {
    stores("safari", "firefox");
    platform.routes[LISTING("firefox")] = () => ({ body: { store: "firefox", listing: { title: "Widget" }, media: {}, updatedAt: "2026-11-06T23:19:00.000Z" } });

    const out = await real(["safari", "firefox"], { projectPath: project("d".repeat(SAFARI_DESCRIPTION_MAX)) });

    expect(out.status).toBe("approval-required");
    expect(out.warnings).not.toContain(SAFARI_DESCRIPTION_UNCHECKED);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(1);
    expect(platform.sent("GET", `${PROJECT_ROUTE}/stores/firefox/listing`)).toHaveLength(1);
  });

  it("warns that the Safari description check did not run when no projectPath is given, and still asks for the approval", async () => {
    stores("safari");

    const out = await real(["safari"]);

    expect(out.status).toBe("approval-required");
    expect(out.warnings).toContain(SAFARI_DESCRIPTION_UNCHECKED);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(1);
  });

  it("refuses a Firefox submit as platform-unavailable before any approval POST when the submit route's dry run names a missing store run, and the preflight fails the integration stage with the same row (ledger 508)", async () => {
    stores("firefox");
    platform.routes[LISTING("firefox")] = () => ({ body: ON_FILE });
    platform.routes[`POST ${DISPATCH}`] = () => ({ status: 404, body: { message: NO_STORE_RUN } });

    const out = await real(["firefox"]);

    expect(out.ok).toBe(false);
    expect(out.status).toBe(PLATFORM_UNAVAILABLE_STATUS);
    expect(out.value).toMatchObject({ owner: "platform", refusedBeforeApproval: true, reportUrl: WRITE_FAILURE_REPORT_URL, platformLine: NO_STORE_RUN });
    expect(out.hint).toContain(PLATFORM_UNAVAILABLE_SENTENCE);
    expect(out.hint).toContain(`${WRITE_FAILURE_REPORT_URL} with the project acme/widget, the store firefox and build ${SHA}`);
    expect(said(out)).not.toMatch(/workflow|store\.yml/i);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(platform.sent("POST", DISPATCH).map((call) => call.body)).toEqual([{ browsers: ["firefox"], buildSha: SHA, dryRun: true }]);

    const read = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: SHA, api: API }));
    const view = read.value.stores.firefox as Row;
    const row = (view.failing as Row[]).find((check) => check.id === STORE_RUN_CHECK)!;

    expect(view.canSubmit).toBe(false);
    expect(row).toMatchObject({ owner: "platform", severity: "blocking", reportUrl: WRITE_FAILURE_REPORT_URL });
    expect(row.message).toContain(PLATFORM_UNAVAILABLE_SENTENCE);
    expect(read.value.nextStep.say).toContain(PLATFORM_UNAVAILABLE_SENTENCE);
    expect(said(read)).not.toMatch(/workflow|store\.yml/i);
  });

  it("treats a 409 STORE_RUN_UNAVAILABLE or MIRRORS_FROZEN as the same platform fault with no approval asked, and leaves every other refusal alone", async () => {
    stores("firefox");
    platform.routes[LISTING("firefox")] = () => ({ body: ON_FILE });
    platform.routes[`POST ${DISPATCH}`] = () => ({ status: 409, body: { code: "STORE_RUN_UNAVAILABLE", approvalRefunded: true, message: LANE_NOT_TAKING } });

    const out = await real(["firefox"]);

    expect(out.status).toBe(PLATFORM_UNAVAILABLE_STATUS);
    expect(out.error.platformCode).toBe("STORE_RUN_UNAVAILABLE");
    expect(out.value.approvalRefunded).toBeUndefined();
    expect(out.error.message).toContain("no approval was asked for");
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);

    expect(storeRunUnavailable(409, { code: "MIRRORS_FROZEN", message: "The mirrors are frozen." })).toMatchObject({ code: "MIRRORS_FROZEN" });
    expect(storeRunUnavailable(404, { message: "No store submission workflow (store.yml) found on the project's mirror repository." })).toMatchObject({ status: 404 });
    expect(storeRunUnavailable(404, { message: "Build not found", code: "UNKNOWN_BUILD" })).toBeNull();
    expect(storeRunUnavailable(404, { message: "not found" })).toBeNull();
    expect(storeRunUnavailable(409, { code: "EDGE_PACKAGE_HAS_ARCHIVES", message: "nested archives" })).toBeNull();
    expect(storeRunUnavailable(500, { message: NO_STORE_RUN })).toBeNull();
  });
});

const TOOLCHAIN = { node: "v24.18.1", extensionJs: "4.1.39", packageManager: { name: "npm", version: "12.0.2" } };
const SAMPLE_NOTE =
  "Build from source with Node 22.12.0 and npm 10.9.0 (replace both with the\noutput of node --version and npm --version on the machine that built the\nupload): run npm install, then npx extension build --browser firefox. The\nupload is dist/firefox, byte for byte.";
const WRITTEN = "Build from source with Node 24.18.1, npm 12.0.2 and Extension.js 4.1.39: run npm install, then npx extension build --browser firefox.";

function storeMd(root: string, note: string): void {
  fs.writeFileSync(
    path.join(root, "STORE.md"),
    `# Store metadata\n\n## Listing\n\n- Name: Widget\n\n## Firefox Add-ons\n\n### Reviewer notes\n\nClick the toolbar button.\n\n${note}\n\n### Release notes\n\nFirst release.\n`,
  );
}

describe("506: the preflight compares the Firefox reviewer note's build line with the toolchain that built the upload", () => {
  const platform = useProjectRoutes("extdev-506-");

  function firefox(toolchain: Row | null): void {
    platform.login();
    platform.routes[PREFLIGHT("firefox")] = () => ({ body: report("firefox") });
    platform.routes[LISTING("firefox")] = () => ({ body: { store: "firefox", listing: { title: "Widget" }, media: {}, updatedAt: "2026-11-06T23:19:00.000Z" } });
    platform.routes[SETTINGS] = () => ({ body: { enabledBrowsers: { firefox: true } } });
    platform.routes[BUILD] = () => ({ body: { id: SHA, status: "success", browsers: [{ name: "firefox", status: "success" }], ...(toolchain ? { toolchain } : {}) } });
    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_506", approvalUrl: `${API}/device/approve/apr_506` } });
  }

  async function preflight(extra: Row): Promise<Row> {
    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], api: API, ...extra }));

    return out.value.stores.firefox;
  }

  const warningOf = (view: Row): Row | undefined => (view.warnings as Row[]).find((row) => row.id === REVIEWER_NOTE_TOOLCHAIN_CHECK);

  it("names the template's sample line against the platform build's toolchain, with the exact sentence to write, as a warning that does not block", async () => {
    firefox(TOOLCHAIN);
    const projectPath = project("Blurs names");
    storeMd(projectPath, SAMPLE_NOTE);

    const view = await preflight({ projectPath, buildSha: SHA });
    const warning = warningOf(view)!;

    expect(warning).toMatchObject({
      severity: "advisory",
      actual: "Node 22.12.0 and npm 10.9.0",
      expected: WRITTEN,
      built: { from: `build ${SHA} on extension.dev`, node: "24.18.1", extensionJs: "4.1.39", packageManager: { name: "npm", version: "12.0.2" } },
      write: { file: "STORE.md", section: "## Firefox Add-ons", heading: "### Reviewer notes", with: WRITTEN },
    });

    expect(warning.write.replace).toMatch(/^Build from source with Node 22\.12\.0[\s\S]*--browser firefox\.$/);
    expect(warning.message).toContain('with the "replace both" instruction');
    expect(warning.message).toContain(`build ${SHA} on extension.dev ran Node 24.18.1, npm 12.0.2 and Extension.js 4.1.39`);
    expect(warning.message).toContain(`Replace the sentence under \`### Reviewer notes\` in \`## Firefox Add-ons\` of STORE.md with: ${WRITTEN}`);
    expect(view.canSubmit).toBe(true);
    expect(view.summary.warn).toBe(1);
    expect((view.failing as Row[]).map((row) => row.id)).not.toContain(REVIEWER_NOTE_TOOLCHAIN_CHECK);
  });

  it("falls back to the local build's recorded toolchain when the platform build names none, and a real submit carries the same finding as a warning", async () => {
    firefox(null);
    const projectPath = project("Blurs names");
    storeMd(projectPath, "Build from source with Node 22.12.0 and pnpm 9.0.0: run pnpm install, then pnpm run build:firefox.");
    fs.writeFileSync(path.join(projectPath, "pnpm-lock.yaml"), "");
    const summary = buildSummaryPath(projectPath, "firefox");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(summary, JSON.stringify({ browser: "firefox", toolchain: { node: "v24.18.1", extension_js: "4.1.39", package_manager: { name: "pnpm", version: "10.19.0" } } }));
    const expected = "Build from source with Node 24.18.1, pnpm 10.19.0 and Extension.js 4.1.39: run pnpm install, then pnpm exec extension build --browser firefox.";

    const warning = warningOf(await preflight({ projectPath, buildSha: SHA }))!;

    expect(warning).toMatchObject({ built: { from: "the local firefox build (extension_build)" }, write: { with: expected } });
    expect(warning.message).toContain("says Node 22.12.0 and pnpm 9.0.0, and the local firefox build (extension_build) ran Node 24.18.1, pnpm 10.19.0 and Extension.js 4.1.39");

    const out = JSON.parse(await submit({ action: "submit", browsers: ["firefox"], buildSha: SHA, dryRun: false, api: API, projectPath }));

    expect(out.status).toBe("approval-required");
    expect((out.warnings as string[]).some((line) => line.includes(expected))).toBe(true);
  });

  it("says nothing when the note names what the build ran, or when no build toolchain is known and the note is not the sample", async () => {
    firefox(TOOLCHAIN);
    const matching = project("Blurs names");
    storeMd(matching, WRITTEN);
    const unread = project("Blurs names");
    storeMd(unread, "Build from source with Node 24.18.1 and npm 12.0.2: run npm install, then npx extension build --browser firefox.");

    expect(warningOf(await preflight({ projectPath: matching, buildSha: SHA }))).toBeUndefined();
    expect(warningOf(await preflight({ projectPath: unread }))).toBeUndefined();
  });

  it("flags the sample line even with no build toolchain read, pointing at buildSha or one local build", async () => {
    firefox(null);
    const projectPath = project("Blurs names");
    storeMd(projectPath, SAMPLE_NOTE);

    const warning = warningOf(await preflight({ projectPath }))!;

    expect(warning.message).toContain("No build toolchain was read to fill it");
    expect(warning.write.with).toBeUndefined();
    expect(warning.built).toBeUndefined();
  });

  it("parses the note's build line, renders the sentence a reviewer expects and compares only the versions both sides name", () => {
    expect(reviewerNoteBuildLine(SAMPLE_NOTE)).toMatchObject({ sample: true, node: "22.12.0", packageManager: { name: "npm", version: "10.9.0" } });
    expect(reviewerNoteBuildLine("Click the toolbar button.")).toBeNull();
    expect(toolchainSentence({ node: "24.18.1", packageManager: { name: "bun" } }, { install: "bun install", build: "bun run build:firefox" })).toBe(
      "Build from source with Node 24.18.1 and bun: run bun install, then bun run build:firefox.",
    );

    expect(toolchainDifferences({ node: "24.18.1", packageManager: { name: "npm" } }, { node: "24.18.1", packageManager: { name: "npm", version: "12.0.2" } })).toEqual([]);
    expect(
      toolchainDifferences(
        { node: "22.12.0", packageManager: { name: "npm", version: "10.9.0" }, extensionJs: "4.1.36" },
        { node: "24.18.1", packageManager: { name: "npm", version: "12.0.2" }, extensionJs: "4.1.39" },
      ),
    ).toEqual(["node", "packageManager", "extensionJs"]);
  });
});
