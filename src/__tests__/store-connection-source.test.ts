import { describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = `${PROJECT_ROUTE}/stores/chrome/submissions/preflight`;
const CONNECT = "http://console.extension.localhost/acme/widget/project-settings/stores?connect=chrome";

function readiness(connection: Record<string, unknown>) {
  return {
    store: "chrome",
    summary: { pass: 8, warn: 0, fail: 0, canSubmit: connection.healthy === true },
    checks: [{ id: "credentials", label: "Store credentials", status: "pass", severity: "blocking", message: "" }],
    connection,
    connectUrl: CONNECT,
  };
}

const WORKSPACE = {
  kind: "oauth",
  source: "workspace",
  connectedAs: "team@example.com",
  healthy: true,
  itemId: "abcdefghijklmnopabcdefghijklmnop",
  itemLinked: true,
};

describe("extension_submit reports whose Chrome Web Store account a project uses", () => {
  const platform = useProjectRoutes("extdev-store-source-");

  it("a project the workspace covers answers connection.source workspace with the workspace's Google account", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: readiness(WORKSPACE) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));

    expect(out.value.stores.chrome.connection).toMatchObject({ source: "workspace", connectedAs: "team@example.com", healthy: true });
  });

  it("a project with its own connection answers connection.source project", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: readiness({ ...WORKSPACE, source: "project", connectedAs: "own@example.com" }) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));

    expect(out.value.stores.chrome.connection).toMatchObject({ source: "project", connectedAs: "own@example.com" });
  });

  it("a failing workspace account says it is the workspace's and where an owner reconnects it", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: readiness({ ...WORKSPACE, healthy: false, reason: "invalid_grant" }),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));

    expect(out.status).toBe("store-connection-failed");
    expect(out.value.stores.chrome.connection.source).toBe("workspace");
    expect(out.hint).toContain(
      "The workspace's Chrome Web Store account failed its last check: invalid_grant. A workspace owner reconnects it once in the workspace's Store accounts settings",
    );

    expect(out.hint).not.toContain("Your Chrome Web Store connection failed");
  });

  it("an answer that names no source, or an unknown one, carries none", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: readiness({ ...WORKSPACE, source: "mirror" }) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));

    expect(out.value.stores.chrome.connection.source).toBeUndefined();
  });
});
