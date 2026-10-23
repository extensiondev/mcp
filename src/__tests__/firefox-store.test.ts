import { describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = `${PROJECT_ROUTE}/stores/firefox/submissions/preflight`;
const DOCS = "https://extension.dev/docs/stores/configuration";

function check(id: string, status: "pass" | "fail", message: string, extra: Record<string, unknown> = {}) {
  return { id, status, severity: "blocking", stage: "integration", ownership: "automated", message, docsUrl: DOCS, ...extra };
}

function firefoxReport(checks: Array<Record<string, unknown>>) {
  const fail = checks.filter((c) => c.status === "fail").length;

  return {
    store: "firefox",
    summary: { pass: checks.length - fail, warn: 0, fail, blockingFailures: fail, canSubmit: fail === 0 },
    submissionMode: { id: "unlisted", label: "Unlisted", description: "Signed for self distribution." },
    checks,
  };
}

const UNCONNECTED = firefoxReport([
  check("store.enabled", "fail", "Enable store publishing for this store in project settings."),
  check("store.config_present", "fail", "Add the Firefox add-on id."),
  check("store.credentials_present", "fail", "Save the required store secrets.", { actual: "Missing: STORE_FIREFOX_API_KEY, STORE_FIREFOX_API_SECRET" }),
]);

describe("a Firefox store with no saved AMO credentials answers store-not-connected", () => {
  const platform = useProjectRoutes("extdev-firefox-store-");

  it("names the two values the console form takes, the AMO page that issues them, and the settings page", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: UNCONNECTED });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "603fc8a", api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("store-not-connected");
    expect(out.value.connectUrl).toMatch(/\/project-settings\/stores\?connect=firefox$/);
    expect(out.value.nextStep).toMatchObject({ kind: "connect", url: out.value.connectUrl });
    expect(out.hint).toContain("https://addons.mozilla.org/developers/addon/api/key/");
    expect(out.hint).toContain("the JWT issuer and the JWT secret");
    expect(out.hint).toContain("add-on id or its AMO dashboard address");
    expect(out.hint).toContain(out.value.connectUrl);
    expect(out.value.stores.firefox.failing.map((c: { id: string }) => c.id)).toEqual(["store.enabled", "store.config_present", "store.credentials_present"]);
    expect(JSON.stringify(out)).not.toContain("STORE_FIREFOX_API_KEY");
    expect(JSON.stringify(out)).not.toContain("STORE_FIREFOX_API_SECRET");
  });

  it("keeps the failing checks when the credentials are saved and only the store setting is off", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: firefoxReport([
        check("store.enabled", "fail", "Enable store publishing for this store in project settings."),
        check("store.config_present", "pass", "Store configuration is present."),
        check("store.credentials_present", "pass", "Store credentials are saved."),
      ]),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("preflight-read");
    expect(out.value.connectUrl).toBeUndefined();
    expect(out.value.stores.firefox.failing).toHaveLength(1);
  });
});

const CONNECTED = [
  check("store.enabled", "pass", "Store publishing is enabled."),
  check("store.config_present", "pass", "Store configuration is present."),
  check("store.credentials_present", "pass", "Store credentials are saved."),
];

function sourceArchive(status: "pass" | "warn") {
  return {
    id: "store.firefox_source_archive",
    label: "Firefox source archive",
    status,
    severity: status === "pass" ? "info" : "warning",
    stage: "integration",
    ownership: "shared",
    message: status === "pass" ? "The source repository at the built commit will be attached." : "This project publishes with no source archive attached.",
    expected: "repository",
    actual: status === "pass" ? "repository" : "none",
    docsUrl: "https://extensionworkshop.com/documentation/publish/source-code-submission/",
  };
}

describe("the Firefox answers say whether the platform attaches the AMO source archive", () => {
  const platform = useProjectRoutes("extdev-firefox-sources-");

  it("preflight says no source archive is configured, in one sentence with the settings page, when the check warns", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: firefoxReport([...CONNECTED, sourceArchive("warn")]) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("preflight-read");
    expect(out.value.stores.firefox.sourceArchive).toMatchObject({ attached: false, setting: "none" });
    expect(out.value.stores.firefox.sourceArchive.say).toMatch(/^Firefox source archive: no source archive is configured; Mozilla requires matching sources for a bundled build/);
    expect(out.value.stores.firefox.sourceArchive.say).toMatch(/turn on Source archive in the console's Firefox store settings at http.*\/project-settings\/stores\?connect=firefox\.$/);
    expect(out.hint).toContain(out.value.stores.firefox.sourceArchive.say);
    expect(out.value.stores.firefox.warnings.map((c: { id: string }) => c.id)).toEqual(["store.firefox_source_archive"]);
  });

  it("preflight says the platform will attach the source repository at the built commit when the check passes", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: firefoxReport([...CONNECTED, sourceArchive("pass")]) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "603fc8a", api: API }));

    expect(out.value.stores.firefox.sourceArchive).toMatchObject({ attached: true, setting: "repository" });
    expect(out.hint).toContain("Firefox source archive: the platform will attach the source repository at the built commit to the upload for Mozilla's reviewers.");
  });

  it("submit says sources attached when the platform's submission record carries the archive", async () => {
    if (process.platform === "win32") return;

    platform.login();

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";

    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: firefoxReport([...CONNECTED, sourceArchive("warn")]) });

    platform.routes["POST /api/cli/stores/submit"] = () => ({
      body: { ok: true, projectId: "prj_probe", buildId: "abc1234", channel: "stable", submissions: [{ id: "sub-1", store: "firefox", status: "pending" }], origin: "mcp" },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: "sub-1", store: "firefox", status: "submitted", buildId: "abc1234", channel: "stable", sourceArchive: "repository" }] },
    });

    const out = JSON.parse(await submit({ browsers: ["firefox"], buildSha: "abc1234", dryRun: false, api: API }));

    expect(out.status).toBe("submitted");
    expect(out.value.firefoxSourceArchive).toMatchObject({ attached: true, source: "platform-record" });
    expect(out.hint).toContain("Firefox: sources attached; the platform's record says the source repository at the built commit went with the upload.");
  });

  it("submit reads the store setting at submit time when the record is silent, and says so", async () => {
    if (process.platform === "win32") return;

    platform.login();

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";

    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: firefoxReport([...CONNECTED, sourceArchive("warn")]) });

    platform.routes["POST /api/cli/stores/submit"] = () => ({
      body: { ok: true, projectId: "prj_probe", buildId: "abc1234", channel: "stable", submissions: [{ id: "sub-1", store: "firefox", status: "pending" }], origin: "mcp" },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: "sub-1", store: "firefox", status: "submitted", buildId: "abc1234", channel: "stable" }] },
    });

    const out = JSON.parse(await submit({ browsers: ["firefox"], buildSha: "abc1234", dryRun: false, api: API }));

    expect(out.status).toBe("submitted");
    expect(out.value.firefoxSourceArchive).toMatchObject({ attached: false, source: "store-setting" });
    expect(out.hint).toMatch(/Firefox: no sources attached; the upload went without a source archive/);
  });
});
