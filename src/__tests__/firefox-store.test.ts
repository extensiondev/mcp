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

const SOURCE_ARCHIVE_SWITCH = "The Firefox store settings also hold the Source archive switch, which Mozilla's review needs for a bundled build; every platform build is bundled.";

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

  it("names the Source archive switch in one sentence when www omits the check before the store is connected", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: UNCONNECTED });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("store-not-connected");
    expect(out.value.stores.firefox.sourceArchive).toBeUndefined();
    expect(out.hint).toContain(SOURCE_ARCHIVE_SWITCH);
    expect(out.value.nextStep.say).toBe(out.hint);
  });

  it("carries the source archive read and its sentence when www sends the check with the credentials missing", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: firefoxReport([...UNCONNECTED.checks, sourceArchive("warn")]) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("store-not-connected");
    expect(out.value.stores.firefox.sourceArchive).toMatchObject({ attached: false, setting: "none" });
    expect(out.hint).toContain(out.value.stores.firefox.sourceArchive.say);
    expect(out.hint).not.toContain(SOURCE_ARCHIVE_SWITCH);
  });
});

const SWITCH_OFF = [
  check("store.enabled", "fail", "Enable store publishing for this store in project settings."),
  check("store.config_present", "pass", "Store configuration is present."),
  check("store.credentials_present", "pass", "Store credentials are saved."),
];

describe("a store whose credentials are saved and whose Store publishing switch is off answers store-not-connected", () => {
  const platform = useProjectRoutes("extdev-store-switch-");

  it("Firefox answers the settings page, the switch sentence and the Source archive sentence", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: firefoxReport(SWITCH_OFF) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "603fc8a", api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("store-not-connected");
    expect(out.value.connectUrl).toMatch(/\/project-settings\/stores\?connect=firefox$/);
    expect(out.value.nextStep).toMatchObject({ kind: "connect", url: out.value.connectUrl });
    expect(out.hint).toContain(`The Firefox AMO credentials are saved for this project and only the "Store publishing" switch for that store is off`);
    expect(out.hint).toContain(`turn it on in the store settings at ${out.value.connectUrl}, then say preflight again.`);
    expect(out.hint).toContain("The console's Connect flow will save the credentials and turn the switch on in one step soon.");
    expect(out.hint).toContain(SOURCE_ARCHIVE_SWITCH);
    expect(out.hint).not.toContain("https://addons.mozilla.org/developers/addon/api/key/");
    expect(out.value.stores.firefox.failing.map((c: { id: string }) => c.id)).toEqual(["store.enabled"]);
    expect(out.warnings).toContain("This read wrote nothing.");
  });

  it("Firefox carries the source archive read in place of the switch sentence when www sends the check", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: firefoxReport([...SWITCH_OFF, sourceArchive("pass")]) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("store-not-connected");
    expect(out.value.stores.firefox.sourceArchive).toMatchObject({ attached: true, setting: "repository" });
    expect(out.hint).toContain("Firefox source archive: the platform will attach the source repository at the built commit to the upload for Mozilla's reviewers.");
    expect(out.hint).not.toContain(SOURCE_ARCHIVE_SWITCH);
  });

  it("Edge answers the same shape with its own settings page and no Firefox sentence", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/stores/edge/submissions/preflight`] = () => ({ body: { ...firefoxReport(SWITCH_OFF), store: "edge" } });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["edge"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("store-not-connected");
    expect(out.value.connectUrl).toMatch(/\/project-settings\/stores\?connect=edge$/);
    expect(out.hint).toContain("The Edge Add-ons credentials are saved for this project");
    expect(out.hint).toContain(out.value.connectUrl);
    expect(out.hint).not.toContain("Source archive");
  });

  it("Chrome answers the same shape once its account is connected and its item linked", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/stores/chrome/submissions/preflight`] = () => ({
      body: {
        ...firefoxReport([check("store.enabled", "fail", "Enable store publishing for this store in project settings.")]),
        store: "chrome",
        connection: { kind: "oauth", connectedAs: "owner@example.com", healthy: true, itemId: "abcdefghijklmnopabcdefghijklmnop", itemLinked: true },
      },
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("store-not-connected");
    expect(out.value.connectUrl).toMatch(/\/project-settings\/stores\?connect=chrome$/);
    expect(out.hint).toContain("The Chrome Web Store credentials are saved for this project");
    expect(out.hint).toContain(out.value.connectUrl);
  });

  it("keeps the readiness answer when the switch is off and the credentials are missing on a store other than Firefox", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/stores/edge/submissions/preflight`] = () => ({ body: { ...UNCONNECTED, store: "edge" } });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["edge"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("preflight-read");
    expect(out.value.connectUrl).toBeUndefined();
    expect(out.value.stores.edge.failing).toHaveLength(3);
  });

  it("keeps the readiness answer when the switch is on and another check fails", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: firefoxReport([...CONNECTED, check("listing.title", "fail", "Add a title to the store listing.")]),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("preflight-read");
    expect(out.value.connectUrl).toBeUndefined();
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
    expect(out.value.stores.firefox.sourceArchive.say).toMatch(/turn on Source archive with extension_submit action:"configure-store" store:"firefox" storeSettings:\{sourceArchive:"repository"\} \(one owner approval\) or in the console's Firefox store settings at http.*\/project-settings\/stores\?connect=firefox\.$/);
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
