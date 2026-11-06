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

import { FIREFOX_LISTING_CHECK, SAFARI_DESCRIPTION_CHECK, SAFARI_DESCRIPTION_MAX } from "../lib/store-preflight-local";
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
});
