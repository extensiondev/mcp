// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit-local";
import { API, useProjectRoutes } from "./fixtures/project-routes";

const SUBMIT = "/api/cli/stores/submit";
const SAID = "You have reached your monthly build limit (25). It resets next month. Pro is $29 per workspace per month and includes 350 builds a month.";
const PRICING = "https://www.extension.dev/pricing";

describe("a submission refused for a spent month says the platform's sentence as it came", () => {
  const platform = useProjectRoutes("extdev-submit-priced-refusal-");

  it("prints the priced message with no prefix and answers the upgrade link", async () => {
    if (process.platform === "win32") return;

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.login();
    platform.routes[`POST ${SUBMIT}`] = () => ({ status: 429, body: { code: "monthly_cap", message: SAID, upgradeUrl: PRICING } });

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "b418732", dryRun: false, api: API }));

    expect(out.status).toBe("submit-failed");
    expect(out.error.platformCode).toBe("monthly_cap");
    expect(out.error.message).toBe(SAID);
    expect(out.value.upgradeUrl).toBe(PRICING);
  });

  it("keeps the fallback sentence and names no upgrade link when the refusal has no message", async () => {
    if (process.platform === "win32") return;

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.login();
    platform.routes[`POST ${SUBMIT}`] = () => ({ status: 429, body: { code: "monthly_cap" } });

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "b418732", dryRun: false, api: API }));

    expect(out.error.message).toMatch(/^submit failed \(429\): /);
    expect(out.value?.upgradeUrl).toBeUndefined();
  });
});
