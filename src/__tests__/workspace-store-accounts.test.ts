import { describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const DOCS = "https://extension.dev/docs/stores/configuration";

function check(id: string, status: "pass" | "fail") {
  return { id, status, severity: "blocking", stage: "integration", ownership: "automated", message: id, docsUrl: DOCS };
}

const PASSING = [check("store.enabled", "pass"), check("store.config_present", "pass"), check("store.credentials_present", "pass")];

function report(store: string, healthy: boolean | null) {
  return {
    store,
    summary: { pass: 3, warn: 0, fail: 0, blockingFailures: 0, canSubmit: true },
    submissionMode: { id: store === "edge" ? "draft" : "unlisted", label: "Draft", description: "Stops at a draft." },
    checks: PASSING,
    connectionSource: "workspace",
    connection: { kind: store === "edge" ? "apiKey" : "jwt", connectedAs: "user:1:2", healthy, source: "workspace" },
  };
}

describe("a project the workspace's store account covers is never told to connect the store", () => {
  const platform = useProjectRoutes("extdev-workspace-store-accounts-");

  it("reads ready, names the workspace's account once, and links no per-project connect form", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/stores/firefox/submissions/preflight`] = () => ({ body: report("firefox", true) });
    platform.routes[`POST ${PROJECT_ROUTE}/stores/edge/submissions/preflight`] = () => ({ body: report("edge", true) });

    const raw = await submit({ action: "preflight", browsers: ["firefox", "edge"], buildSha: "603fc8a", api: API });
    const out = JSON.parse(raw);

    expect(out.ok).toBe(true);
    expect(out.status).toBe("preflight-read");
    expect(out.value.stores.firefox.connectionSource).toBe("workspace");
    expect(out.value.stores.firefox.connection.source).toBe("workspace");
    expect(out.value.stores.edge.connectionSource).toBe("workspace");
    expect(out.hint).toContain("Firefox AMO uses the workspace's account (user:1:2).");
    expect(out.value.nextStep?.kind).not.toBe("connect");
    expect(raw).not.toContain("?connect=");
    expect(raw).not.toMatch(/is not connected/);
  });

  it("sends an unchecked workspace account to the workspace's Store accounts page, never a project connect form", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/stores/firefox/submissions/preflight`] = () => ({ body: report("firefox", null) });

    const raw = await submit({ action: "preflight", browsers: ["firefox"], buildSha: "603fc8a", api: API });
    const out = JSON.parse(raw);

    expect(out.status).toBe("store-connection-unverified");
    expect(out.value.connectionSource).toBe("workspace");
    expect(out.value.nextStep.kind).toBe("configure");
    expect(out.value.nextStep.url).toMatch(/\/acme\/settings\/store-accounts$/);
    expect(out.hint).toContain("The workspace's Firefox Add-ons account has not been checked");
    expect(raw).not.toContain("?connect=");
  });

  it("configure-store reports the connection's source and names the workspace's account", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PUT ${PROJECT_ROUTE}/stores/config`] = () => ({ body: { ok: true, store: "firefox", changes: ["firefox: enable store publishing"] } });
    platform.routes[`GET ${PROJECT_ROUTE}/stores/config`] = () => ({
      body: { firefox: { enabled: true, connection: { kind: "jwt", connectedAs: "user:1:2", healthy: true, source: "workspace" } } },
    });

    const out = JSON.parse(await submit({ action: "configure-store", store: "firefox", storeSettings: { enabled: true }, api: API }));

    expect(out.status).toBe("store-configured");
    expect(out.value.connection).toEqual({ source: "workspace", connectedAs: "user:1:2", healthy: true });
    expect(out.value.sayToPerson).toContain("Firefox AMO uses the workspace's account (user:1:2).");
  });
});
