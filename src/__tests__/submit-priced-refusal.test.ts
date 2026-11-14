// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { allowanceRefusal } from "../lib/platform-hold";
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

describe("a plan boundary is said without the upgrade sentence the console reads", () => {
  const platform = useProjectRoutes("extdev-submit-plan-boundary-");
  const PITCHED = `Safari submissions run on a macOS runner. It is not included on this plan. Upgrade this workspace to submit to the App Store: ${PRICING}`;
  const PLAIN = "Safari submissions build a signed macOS installer package on a macOS runner, which this workspace's plan does not include, so nothing was dispatched.";

  it("relays the platform's neutral sentence for a Safari submit and drops the pitch and the pricing link", async () => {
    if (process.platform === "win32") return;

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.login();
    platform.routes[`POST ${SUBMIT}`] = () => ({
      status: 403,
      body: { code: "MACOS_RUNNER_NOT_INCLUDED", message: PITCHED, upgradeUrl: PRICING, store: "safari", limitReached: "Safari builds and App Store submissions are not included on this workspace's plan", billingUrl: BILLING, neutralMessage: `${PLAIN} Manage the plan at ${BILLING}.` },
    });

    const out = JSON.parse(await submit({ browsers: ["safari"], buildSha: "b418732", dryRun: false, api: API }));

    expect(out.error.platformCode).toBe("MACOS_RUNNER_NOT_INCLUDED");
    expect(out.error.message).toBe(`${PLAIN} Manage the plan at ${BILLING}.`);
    expect(out.value).toMatchObject({ limitReached: "Safari builds and App Store submissions are not included on this workspace's plan", billingUrl: BILLING });
    expect(out.value).not.toHaveProperty("resetsAt");
    expect(JSON.stringify(out)).not.toMatch(/upgrade|\/pricing/i);
  });

  it.each([
    ["MACOS_RUNNER_NOT_INCLUDED", "Safari builds and App Store submissions are not included on this workspace's plan", "Safari builds and App Store submissions are not included on this workspace's plan, so this was refused and nothing ran."],
    ["MACOS_NOTARIZATION_NOT_INCLUDED", "notarizing macOS executables is not included on this workspace's plan", "Notarizing macOS executables is not included on this workspace's plan, so this was refused and nothing ran."],
  ])("composes %s from the code alone when an older platform sends only its upgrade sentence", (code, limitReached, said) => {
    expect(allowanceRefusal({ code, message: PITCHED, upgradeUrl: PRICING, resetsAt: RESETS }, BILLING)).toEqual({
      message: `${said} Manage the plan at ${BILLING}.`,
      limitReached,
      resetsAt: "",
      billingUrl: BILLING,
    });
  });
});
