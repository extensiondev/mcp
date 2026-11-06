// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

type Row = Record<string, any>;

const PREFLIGHT = `POST ${PROJECT_ROUTE}/stores/safari/submissions/preflight`;
const SETTINGS = `GET ${PROJECT_ROUTE}/settings/build`;
const SHA = "9b87ebd";
const BUILD = `GET ${PROJECT_ROUTE}/builds/${SHA}`;
const DRY_RUN = "POST /api/cli/stores/submit";
const APPROVALS = "/api/cli/approvals";
const CONFIGURE_CALL = 'extension_builds {action: "configure", buildSettings: {safari: {enabled: true}}}';
const REBUILD_CALL = `extension_builds {action: "rebuild", buildSha: "${SHA}"}`;
const NOT_CONFIGURED = "No safari store is configured";

const CONNECTED = { kind: "app-store-connect", connectedAs: "Visionario", healthy: true, itemId: "6749000000", itemLinked: true };

function report(connection: Row): Row {
  return {
    store: "safari",
    summary: { pass: 3, warn: 0, fail: 0, blockingFailures: 0, canSubmit: true },
    checks: [{ id: "store.safari_bundle_identifiers", label: "Bundle identifiers", status: "pass", message: "com.visionario.hands-free is set." }],
    connection,
  };
}

function settings(safariOn: boolean): Row {
  const on = { enabled: true, installCommand: "pnpm install", buildCommand: "pnpm build", outputDirectory: "dist" };

  return {
    buildSettings: { chrome: on, edge: on, firefox: on, safari: { ...on, enabled: safariOn } },
    enabledBrowsers: { chrome: true, edge: true, firefox: true, safari: safariOn },
  };
}

function build(browsers: string[]): Row {
  return { id: SHA, buildId: SHA, status: "success", conclusion: "success", browsers: browsers.map((name) => ({ name, status: "success" })) };
}

async function call(args: Row): Promise<Row> {
  return JSON.parse(await submit({ ...args, api: API }));
}

describe("the Safari preflight reads whether the project builds Safari at all (ledger 456)", () => {
  const platform = useProjectRoutes("extdev-safari-builds-off-");

  it("answers not ready with the builds-off requirement and its exact fix when the App Store is connected and Safari builds are off", async () => {
    platform.login();
    platform.routes[PREFLIGHT] = () => ({ body: report(CONNECTED) });
    platform.routes[SETTINGS] = () => ({ body: settings(false) });

    const out = await call({ action: "preflight", browsers: ["safari"] });
    const safari = out.value.stores.safari;
    const said = JSON.stringify(out);

    expect(out.status).toBe("preflight-read");
    expect(safari.canSubmit).toBe(false);
    expect(safari.summary).toMatchObject({ fail: 1, blockingFailures: 1, canSubmit: false });
    expect(safari.failing[0]).toMatchObject({ id: "safari.builds", label: "Safari builds", severity: "blocking", message: "Safari builds are off for this project, so no build carries a safari artifact." });
    expect(safari.failing[0].fix).toContain(CONFIGURE_CALL);
    expect(safari.failing[0].fix).toContain("under Browser builds at http://console.extension.localhost/acme/widget/project-settings");
    expect(safari.browserBuilds).toMatchObject({ state: "browser-builds-off", enabled: false, configureCall: CONFIGURE_CALL });
    expect(out.value.nextStep.kind).toBe("configure");
    expect(out.value.nextStep.url).toContain("/acme/widget/project-settings");
    expect(out.value.nextStep.say).toContain("Safari builds are off for this project");
    expect(out.value.nextStep.say).toContain(CONFIGURE_CALL);
    expect(out.value.sayToPerson).toContain("Safari builds are off for this project");
    expect(out.value.sayToPerson).toContain(CONFIGURE_CALL);
    expect(out.value.sayToPerson).toContain("safari cannot be submitted yet");
    expect(said).not.toContain("Every store read here is ready to submit");
    expect(said).not.toContain(NOT_CONFIGURED);
    expect(said).not.toContain("connect=safari");
  });

  it("names the asked build's missing artifact when the preflight carries a buildSha", async () => {
    platform.login();
    platform.routes[PREFLIGHT] = () => ({ body: report(CONNECTED) });
    platform.routes[SETTINGS] = () => ({ body: settings(false) });
    platform.routes[BUILD] = () => ({ body: build(["chrome", "firefox", "edge"]) });

    const out = await call({ action: "preflight", browsers: ["safari"], buildSha: SHA });

    expect(out.value.stores.safari.failing[0].message).toBe(`Build ${SHA} has no safari artifact because Safari builds are off for this project.`);
    expect(out.value.stores.safari.browserBuilds).toMatchObject({ buildSha: SHA, artifact: false });
    expect(out.value.nextStep.say).toContain(REBUILD_CALL);
  });

  it("answers the same ready preflight as before when Safari builds are on", async () => {
    platform.login();
    platform.routes[PREFLIGHT] = () => ({ body: report(CONNECTED) });
    platform.routes[SETTINGS] = () => ({ body: settings(true) });

    const out = await call({ action: "preflight", browsers: ["safari"] });
    const said = JSON.stringify(out);

    expect(out.value.stores.safari.canSubmit).toBe(true);
    expect(out.value.stores.safari.browserBuilds).toBeUndefined();
    expect(out.value.nextStep.kind).toBe("submit");
    expect(out.value.sayToPerson).toContain("Every store read here is ready to submit.");
    expect(said).not.toContain("builds are off");
  });

  it("changes nothing when the build settings cannot be read", async () => {
    platform.login();
    platform.routes[PREFLIGHT] = () => ({ body: report(CONNECTED) });

    const out = await call({ action: "preflight", browsers: ["safari"] });

    expect(out.value.stores.safari.canSubmit).toBe(true);
    expect(out.value.nextStep.kind).toBe("submit");
    expect(JSON.stringify(out)).not.toContain("builds are off");
  });
});

describe("the submit names the missing Safari artifact and never sends a connected store back to connect (ledger 456)", () => {
  const platform = useProjectRoutes("extdev-safari-builds-off-submit-");

  it("a dry run on a build with no safari artifact says Safari builds are off, with the configure fix, when the store is connected", async () => {
    platform.login();
    platform.routes[PREFLIGHT] = () => ({ body: report(CONNECTED) });
    platform.routes[SETTINGS] = () => ({ body: settings(false) });
    platform.routes[BUILD] = () => ({ body: build(["chrome", "firefox", "edge"]) });
    platform.routes[DRY_RUN] = () => ({ body: { ok: true, dryRun: true, buildId: SHA, message: "Preflight OK." } });

    const out = await call({ action: "submit", browsers: ["safari"], buildSha: SHA, dryRun: true });
    const said = JSON.stringify(out);

    expect(out.ok).toBe(false);
    expect(out.value.verdict).toBe("browser-builds-off");
    expect(out.value.preflight[0]).toMatchObject({ browser: "safari", ok: false, state: "browser-builds-off", configured: true, healthy: true, source: "connection" });
    expect(out.value.preflight[0].reason).toBe(`Build ${SHA} has no safari artifact because Safari builds are off for this project.`);
    expect(out.value.nextStep.kind).toBe("configure");
    expect(out.value.nextStep.say).toContain(CONFIGURE_CALL);
    expect(out.value.nextStep.say).toContain(REBUILD_CALL);
    expect(out.value.trackUrl).toContain("/acme/widget/project-settings");
    expect(out.hint).toContain("Not ready for safari: Build 9b87ebd has no safari artifact because Safari builds are off for this project.");
    expect(said).not.toContain(NOT_CONFIGURED);
    expect(said).not.toContain("connect=safari");
  });

  it("a dry run whose store preflight refuses the build still says Safari builds are off instead of blaming the store connection", async () => {
    platform.login();
    platform.routes[PREFLIGHT] = () => ({ status: 409, body: { code: "BUILD_HAS_NO_PACKAGE", message: `Build ${SHA} has no safari package.` } });
    platform.routes[SETTINGS] = () => ({ body: settings(false) });
    platform.routes[BUILD] = () => ({ body: build(["chrome", "firefox", "edge"]) });
    platform.routes[DRY_RUN] = () => ({ body: { ok: true, dryRun: true, buildId: SHA, message: "Preflight OK." } });

    const out = await call({ action: "submit", browsers: ["safari"], buildSha: SHA, dryRun: true });
    const said = JSON.stringify(out);

    expect(out.value.verdict).toBe("browser-builds-off");
    expect(out.value.preflight[0]).toMatchObject({ browser: "safari", state: "browser-builds-off", configured: "not checked", source: "none" });
    expect(out.value.nextStep.say).toContain(CONFIGURE_CALL);
    expect(said).not.toContain(NOT_CONFIGURED);
    expect(said).not.toContain("connect=safari");
  });

  it("a store that is truly not connected keeps the connect wording even while Safari builds are off", async () => {
    platform.login();
    platform.routes[PREFLIGHT] = () => ({ body: report({ kind: null, connectedAs: null, healthy: null, itemId: null }) });
    platform.routes[SETTINGS] = () => ({ body: settings(false) });
    platform.routes[BUILD] = () => ({ body: build(["chrome", "firefox", "edge"]) });
    platform.routes[DRY_RUN] = () => ({ body: { ok: true, dryRun: true, buildId: SHA, message: "Preflight OK." } });

    const out = await call({ action: "submit", browsers: ["safari"], buildSha: SHA, dryRun: true });

    expect(out.value.verdict).toBe("store-not-connected");
    expect(out.value.nextStep.kind).toBe("connect");
    expect(out.value.nextStep.say).toContain("Set up the safari store once at");
    expect(out.value.nextStep.say).toContain("connect=safari");
    expect(out.value.nextStep.say).not.toContain("builds are off");
  });

  it("a real submit refuses before any approval with the builds-off cause and the configure fix", async () => {
    platform.login();
    platform.routes[PREFLIGHT] = () => ({ body: report(CONNECTED) });
    platform.routes[SETTINGS] = () => ({ body: settings(false) });
    platform.routes[BUILD] = () => ({ body: build(["chrome", "firefox", "edge"]) });

    const out = await call({ action: "submit", browsers: ["safari"], buildSha: SHA, dryRun: false });
    const said = JSON.stringify(out);

    expect(out.ok).toBe(false);
    expect(out.status).toBe("browser-builds-off");
    expect(out.error.name).toBe("BrowserBuildsOff");
    expect(out.error.message).toBe(`Build ${SHA} has no safari artifact because Safari builds are off for this project. Nothing was submitted and no approval was asked for.`);
    expect(out.value.browserBuilds).toMatchObject({ state: "browser-builds-off", enabled: false, buildSha: SHA, artifact: false, configureCall: CONFIGURE_CALL, rebuildCall: REBUILD_CALL });
    expect(out.value.nextStep.kind).toBe("configure");
    expect(out.value.nextStep.say).toContain(CONFIGURE_CALL);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(platform.sent("POST", "/api/cli/stores/submit")).toHaveLength(0);
    expect(said).not.toContain(NOT_CONFIGURED);
    expect(said).not.toContain("connect=safari");
  });

  it("a build that ran before Safari builds were switched on names the missing artifact and the rebuild, not the switch", async () => {
    platform.login();
    platform.routes[PREFLIGHT] = () => ({ body: report(CONNECTED) });
    platform.routes[SETTINGS] = () => ({ body: settings(true) });
    platform.routes[BUILD] = () => ({ body: build(["chrome", "firefox", "edge"]) });
    platform.routes[DRY_RUN] = () => ({ body: { ok: true, dryRun: true, buildId: SHA, message: "Preflight OK." } });

    const out = await call({ action: "submit", browsers: ["safari"], buildSha: SHA, dryRun: true });

    expect(out.value.verdict).toBe("build-artifact-missing");
    expect(out.value.preflight[0].reason).toBe(`Build ${SHA} has no safari artifact, and Safari builds are on for this project.`);
    expect(out.value.nextStep.say).toContain(REBUILD_CALL);
    expect(out.value.nextStep.say).not.toContain(CONFIGURE_CALL);
    expect(JSON.stringify(out)).not.toContain(NOT_CONFIGURED);
  });
});
