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
const BILLING = "https://console.extension.dev/acme/settings/plan";
const RESETS = "2026-12-01T00:00:00.000Z";
const NEUTRAL = `This workspace reached its monthly build limit (25 builds), so nothing was submitted. The limit resets at ${RESETS}.`;

describe("a submission refused for a spent month names the limit, its reset and the billing page, never a price", () => {
  const platform = useProjectRoutes("extdev-submit-priced-refusal-");

  it("relays the neutral sentence and fields and drops the priced sentence and the upgrade link", async () => {
    if (process.platform === "win32") return;

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.login();
    platform.routes[`POST ${SUBMIT}`] = () => ({ status: 429, body: { code: "monthly_cap", message: SAID, upgradeUrl: PRICING, limitReached: "monthly build limit (25 builds)", resetsAt: RESETS, billingUrl: BILLING, neutralMessage: NEUTRAL } });

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "b418732", dryRun: false, api: API }));

    expect(out.status).toBe("submit-failed");
    expect(out.error.platformCode).toBe("monthly_cap");
    expect(out.error.message).toBe(`${NEUTRAL} Manage the plan at ${BILLING}.`);
    expect(out.value).toMatchObject({ limitReached: "monthly build limit (25 builds)", resetsAt: RESETS, billingUrl: BILLING });
    expect(JSON.stringify(out)).not.toMatch(/\$29|upgradeUrl|\/pricing|Pro is/);
  });

  it("composes the same three facts when an older platform sends only its priced sentence", async () => {
    if (process.platform === "win32") return;

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.login();
    platform.routes[`POST ${SUBMIT}`] = () => ({ status: 429, body: { code: "monthly_cap", message: SAID, upgradeUrl: PRICING } });

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "b418732", dryRun: false, api: API }));

    expect(out.error.message).toMatch(/^This workspace reached its monthly build limit, so this was refused and nothing ran\. The limit resets at the start of next month \(UTC\)\. Manage the plan at https?:\/\/\S+\/settings\/plan\.$/);
    expect(out.value.billingUrl).toMatch(/\/settings\/plan$/);
    expect(JSON.stringify(out)).not.toMatch(/\$29|upgradeUrl|\/pricing|Pro is/);
  });
});
