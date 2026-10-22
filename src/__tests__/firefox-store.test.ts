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
