import { describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const RESEAL =
  "This project uses the workspace's Firefox Add-ons account (user:15559442:832), which was saved before the platform kept store keys itself, so no run can read it yet. A workspace owner reconnects it once in the workspace's Store accounts with the same JWT issuer and JWT secret the workspace already uses; do not generate a new key at addons.mozilla.org, because a new AMO key revokes the old one for every project that uses it.";

function report(store: string, reason: string) {
  return {
    store,
    summary: { pass: 10, warn: 0, fail: 1, canSubmit: false },
    checks: [
      {
        id: "store.credentials_present",
        label: "The workspace's store account is ready for this project",
        status: "fail",
        severity: "blocking",
        message: reason,
        blocking: true,
      },
    ],
    connectionSource: "workspace",
    connection: {
      kind: store === "edge" ? "apiKey" : "jwt",
      source: "workspace",
      connectedAs: "user:15559442:832",
      healthy: false,
      reason,
      state: "workspace-reconnect-required",
    },
  };
}

describe("a workspace store account saved before the platform's vault", () => {
  const platform = useProjectRoutes("extdev-workspace-reconnect-");

  it("is answered as the workspace's account to reconnect with the same key, never with Mozilla's generate-a-key text", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/stores/firefox/submissions/preflight`] = () => ({
      body: report("firefox", RESEAL),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], api: API }));

    expect(out.status).toBe("workspace-reconnect-required");
    expect(out.hint).toContain("(user:15559442:832)");
    expect(out.hint).toContain("do not generate a new key");
    expect(out.hint).toContain("/settings/store-accounts");
    expect(out.hint).not.toContain("is not connected to this project yet");
    expect(out.hint).not.toContain("Mozilla issues the two values once");
    expect(out.hint).not.toContain("re-copy");
    expect(out.value.nextStep.kind).toBe("configure");
    expect(out.value.nextStep.url ?? out.value.trackUrl).toContain("/settings/store-accounts");
  });

  it("answers Edge the same way", async () => {
    if (process.platform === "win32") return;

    const reason = RESEAL.replace("Firefox Add-ons", "Microsoft Edge Add-ons");

    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/stores/edge/submissions/preflight`] = () => ({
      body: report("edge", reason),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["edge"], api: API }));

    expect(out.status).toBe("workspace-reconnect-required");
    expect(out.hint).toContain("Microsoft Edge Add-ons account");
    expect(out.value.nextStep.kind).toBe("configure");
  });
});
