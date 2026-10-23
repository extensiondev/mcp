import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { approvalVerdict } from "../lib/approval-policy";
import { TOOL_POLICY, TOOL_TITLES } from "../lib/tool-policy";
import { trackFields } from "../lib/track-url";
import { handler as workspace, schema } from "../tools/workspace";
import { PROJECT_SETTINGS_ACTION, SETTINGS_FIELDS, readSettingsChange } from "../tools/workspace-configure";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const GENERAL = `${PROJECT_ROUTE}/settings/general`;
const DEPLOYMENT = `${PROJECT_ROUTE}/settings/deployment`;
const GITHUB = `${PROJECT_ROUTE}/settings/github`;
const RELEASES = `${PROJECT_ROUTE}/settings/releases`;
const BUILD = `${PROJECT_ROUTE}/settings/build`;
const CHANNELS = `${PROJECT_ROUTE}/channels`;
const APPROVALS = "/api/cli/approvals";
const AUDIENCE_ACTION = PROJECT_SETTINGS_ACTION;

const STORED_GENERAL = { displayName: "Widget", description: "Does things", url: "", supportUrl: "", visibility: "private", liveChannel: null, version: "1.2.0", versionSource: "newest-build", extensionName: "Widget", latestBuildSha: "0c7471e" };
const STORED_DEPLOYMENT = { branch: "main", buildPullRequests: true, nodeVersion: "22.x", rootDirectory: "", workspaceRoot: "", runWhatsNew: false, runExtensionExecutables: { linux: false, macos: false, windows: false } };
const STORED_GITHUB = { pullRequestComments: true, commitComments: false, repository: "acme/widget", createdAt: "", installationId: "1" };
const STORED_RELEASES = { autoCreateGitHubRelease: false };
const STORED_BUILD = { buildSettings: { chrome: { enabled: true, installCommand: "pnpm i", buildCommand: "pnpm build", outputDirectory: "dist" } }, enabledBrowsers: { chrome: true, edge: false, firefox: false, safari: false } };

function storeReads(platform: ReturnType<typeof useProjectRoutes>) {
  platform.routes[`GET ${GENERAL}`] = () => ({ body: STORED_GENERAL });
  platform.routes[`GET ${DEPLOYMENT}`] = () => ({ body: STORED_DEPLOYMENT });
  platform.routes[`GET ${GITHUB}`] = () => ({ body: STORED_GITHUB });
  platform.routes[`GET ${RELEASES}`] = () => ({ body: STORED_RELEASES });
  platform.routes[`GET ${BUILD}`] = () => ({ body: STORED_BUILD });
  platform.routes[`GET ${CHANNELS}`] = () => ({
    body: [
      { id: "stable", name: "stable", description: "", color: "#000", createdAt: "", audience: "public" },
      { id: "beta", name: "beta", description: "", color: "#000", createdAt: "", audience: "private" },
    ],
  });
}

describe("extension_workspace configure-project changes a project's settings as plain calls under the owner's token", () => {
  const platform = useProjectRoutes("extdev-workspace-configure-");

  it("offers configure-project with a settings input, is no longer a read-only tool, and the slug is not a field", () => {
    const props = schema.inputSchema.properties as unknown as Record<string, { enum?: string[]; description?: string }>;

    expect(props.action.enum).toContain("configure-project");
    expect(props.settings.description).toContain("displayName");
    expect(props.settings.description).toContain("liveChannel");
    expect(SETTINGS_FIELDS).not.toContain("slug");
    expect(TOOL_POLICY.extension_workspace.annotations.readOnlyHint).toBe(false);
    expect(TOOL_TITLES.extension_workspace).toBe("Read or change the workspace");
    expect(approvalVerdict(PROJECT_SETTINGS_ACTION)).toBe("plain");
    expect(trackFields("extension_workspace", { args: { action: "configure-project", project: "acme/widget" }, status: "project-configured", value: {} })?.trackUrl).toMatch(/\/acme\/widget\/project-settings\/general$/);
  });

  it("refuses the slug, an unknown field and a wrong type before anything is sent", () => {
    expect(readSettingsChange({ slug: "other" })).toMatchObject({ code: "SLUG_NOT_WRITABLE_HERE" });
    expect(readSettingsChange({ nodeVersion: "20" })).toMatchObject({ problem: expect.stringContaining('"nodeVersion"') });
    expect(readSettingsChange({ branch: 3 })).toMatchObject({ problem: "settings.branch must be a string." });
    expect(readSettingsChange({ runWhatsNew: "yes" })).toMatchObject({ problem: "settings.runWhatsNew must be true or false." });
    expect(readSettingsChange({ runExtensionExecutables: { linux: true } })).toMatchObject({ problem: expect.stringContaining("linux, macos, windows") });
    expect(readSettingsChange({ liveChannel: "" })).toMatchObject({ problem: expect.stringContaining("liveChannel") });
    expect(readSettingsChange({})).toMatchObject({ problem: expect.stringContaining("at least one") });
    expect(readSettingsChange({ liveChannel: null, branch: "main" })).toEqual({ change: { liveChannel: null, branch: "main" } });
  });

  it("writes only the sections whose fields change, as plain calls, minting no approval", async () => {
    if (process.platform === "win32") return;

    platform.login();
    storeReads(platform);
    platform.routes[`PUT ${DEPLOYMENT}`] = () => ({ body: { ok: true } });
    platform.routes[`PUT ${GITHUB}`] = () => ({ body: { ok: true, connected: true } });
    platform.routes[`PUT ${GENERAL}`] = () => ({ body: { ok: true } });

    const out = JSON.parse(
      await workspace({
        action: "configure-project",
        settings: { branch: "release", buildPullRequests: true, commitComments: true, description: "Does things" },
        api: API,
      }),
    );

    expect(out.ok).toBe(true);
    expect(out.status).toBe("project-configured");
    expect(out.value.changes).toEqual(['branch: "main" -> "release"', "commitComments: false -> true"]);
    expect(out.value.applied).toEqual(["deployment", "github"]);
    expect(out.value.trackUrl).toMatch(/\/acme\/widget\/project-settings\/general$/);
    expect(platform.sent("PUT", DEPLOYMENT).map((call) => call.body)).toEqual([{ branch: "release" }]);
    expect(platform.sent("PUT", GITHUB).map((call) => call.body)).toEqual([{ commitComments: true }]);
    expect(platform.sent("PUT", GENERAL)).toHaveLength(0);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.hint).toContain("no approval page was involved");
  });

  it("answers unchanged and writes nothing when every field already reads that way", async () => {
    if (process.platform === "win32") return;

    platform.login();
    storeReads(platform);

    const out = JSON.parse(await workspace({ action: "configure-project", settings: { branch: "main", autoCreateGitHubRelease: false, liveChannel: null }, api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("unchanged");
    expect(platform.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("refuses the slug with the platform's code and sends nothing", async () => {
    if (process.platform === "win32") return;

    platform.login();

    const out = JSON.parse(await workspace({ action: "configure-project", settings: { slug: "widget-2", displayName: "Widget 2" }, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.value.platformCode).toBe("SLUG_NOT_WRITABLE_HERE");
    expect(platform.calls).toHaveLength(0);
  });

  it("is refused OWNER_REQUIRED when the token's minter is not an owner, and asks for no approval", async () => {
    if (process.platform === "win32") return;

    platform.login();
    storeReads(platform);
    platform.routes[`PUT ${RELEASES}`] = () => ({ status: 403, body: { code: "OWNER_REQUIRED", message: "This is a workspace owner action and this token was minted by an account that is not an owner of this workspace." } });

    const out = JSON.parse(await workspace({ action: "configure-project", settings: { autoCreateGitHubRelease: true }, api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.platformCode).toBe("OWNER_REQUIRED");
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });

  it("sets a private live channel as a plain call through the general route", async () => {
    if (process.platform === "win32") return;

    platform.login();
    storeReads(platform);
    platform.routes[`PUT ${GENERAL}`] = () => ({ body: { ok: true, liveChannel: "beta" } });

    const out = JSON.parse(await workspace({ action: "configure-project", settings: { liveChannel: "beta" }, api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.changes).toEqual(['liveChannel: null -> "beta"']);
    expect(platform.sent("PUT", GENERAL).map((call) => call.body)).toEqual([{ liveChannel: "beta" }]);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });

  it("keeps a public live channel on the approve page through the channel-audience row, with nothing written, the plain fields included", async () => {
    if (process.platform === "win32") return;

    platform.login();
    storeReads(platform);
    platform.routes[`PUT ${GENERAL}`] = () => ({ body: { ok: true } });
    platform.routes[`PUT ${DEPLOYMENT}`] = () => ({ body: { ok: true } });
    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_live", approvalUrl: `${API}/device/approve/apr_live` } });

    const out = JSON.parse(await workspace({ action: "configure-project", settings: { liveChannel: "stable", branch: "release" }, api: API }));
    const minted = platform.sent("POST", APPROVALS);

    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-required");
    expect(out.value.approvalId).toBe("apr_live");
    expect(out.value.action).toBe(AUDIENCE_ACTION);
    expect(minted).toHaveLength(1);
    expect(minted[0].body).toMatchObject({ action: AUDIENCE_ACTION, scope: { channel: "stable", audience: "public" }, fingerprint: actionFingerprint(AUDIENCE_ACTION, { channel: "stable", audience: "public" }) });
    expect(platform.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    expect(out.error.message).toContain("public channel");
    expect(out.error.message).toContain("Nothing was executed");
  });

  it("honors the platform asking for the audience approval when this server read the channel as private", async () => {
    if (process.platform === "win32") return;

    platform.login();
    storeReads(platform);
    const scope = { channel: "beta", audience: "public" };

    platform.routes[`PUT ${GENERAL}`] = () => ({
      status: 403,
      body: { code: "APPROVAL_REQUIRED", message: "Ask.", approvalRequest: { action: AUDIENCE_ACTION, scope, fingerprint: actionFingerprint(AUDIENCE_ACTION, scope) } },
    });

    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_asked", approvalUrl: `${API}/device/approve/apr_asked` } });

    const out = JSON.parse(await workspace({ action: "configure-project", settings: { liveChannel: "beta" }, api: API }));

    expect(out.status).toBe("approval-required");
    expect(out.value.approvalId).toBe("apr_asked");
    expect(platform.sent("POST", APPROVALS)).toHaveLength(1);
  });

  it("refuses a live channel the project does not have, naming its channels, and writes nothing", async () => {
    if (process.platform === "win32") return;

    platform.login();
    storeReads(platform);

    const out = JSON.parse(await workspace({ action: "configure-project", settings: { liveChannel: "nightly" }, api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.message).toContain("no channel named nightly");
    expect(out.error.message).toContain("stable, beta");
    expect(platform.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("reads the deployment, GitHub and release settings beside the general and build ones with action settings", async () => {
    if (process.platform === "win32") return;

    platform.login();
    storeReads(platform);

    const out = JSON.parse(await workspace({ action: "settings", api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.general.displayName).toBe("Widget");
    expect(out.value.deployment).toEqual(STORED_DEPLOYMENT);
    expect(out.value.github).toEqual(STORED_GITHUB);
    expect(out.value.releases).toEqual(STORED_RELEASES);
    expect(out.value.enabledBrowsers).toEqual(["chrome"]);
    expect(out.hint).toContain('action: "configure-project"');
  });

  it("warns, instead of failing, when a platform in front of it does not answer deployment settings to a token yet", async () => {
    if (process.platform === "win32") return;

    platform.login();
    storeReads(platform);
    platform.routes[`GET ${DEPLOYMENT}`] = () => ({ status: 401, body: { code: "UNAUTHENTICATED", message: "Sign in" } });

    const out = JSON.parse(await workspace({ action: "settings", api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.deployment).toBeNull();
    expect(out.warnings.join(" ")).toContain("deployment settings could not be read");
  });
});
