// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { attachTrack } from "../lib/track-url";
import { handler as submit } from "../tools/submit-local";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

type Row = Record<string, any>;

const MINT = "/api/cli/stores/safari/signing-assets";
const APPROVALS = "/api/cli/approvals";
const CONFIG = `GET ${PROJECT_ROUTE}/stores/config`;
const SETTINGS = `GET ${PROJECT_ROUTE}/settings/build`;
const SCOPE = { store: "safari", act: "mint-signing", bundleId: "com.acme.widget" };
const STORE_SETTINGS_PAGE = "/acme/widget/project-settings";
const WALK: Record<string, Row> = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./fixtures/preflight-four-stores.json", import.meta.url)), "utf8"));

const DISPATCHED = {
  ok: true,
  status: "mint-dispatched",
  bundleId: "com.acme.widget",
  settingsFilled: ["bundleId"],
  dispatchId: "d-mint-1",
  dispatchedAt: "2026-11-06T20:00:00.000Z",
  usualSeconds: 180,
  runCorrelation: "corr-1",
  trackUrl: `${API}/acme/widget/project-settings/stores`,
  approvalId: "apr_m",
};

async function call(args: Row): Promise<Row> {
  const full = { ...args, api: API };

  return JSON.parse(attachTrack("extension_submit", full, await submit(full)));
}

describe("extension_submit mint-signing runs the Safari signing mint under one owner approval (ledger 454)", () => {
  const platform = useProjectRoutes("extdev-mint-signing-");

  it("asks for the approval the platform names, with its approvalId and a check page, and dispatches nothing", async () => {
    platform.login();
    platform.routes[`POST ${MINT}`] = () => ({
      status: 403,
      body: {
        code: "APPROVAL_REQUIRED",
        message: "Needs an owner's approval.",
        approvalRequest: { action: "extension_store.mint", scope: SCOPE, fingerprint: actionFingerprint("extension_store.mint", SCOPE) },
      },
    });

    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_m", approvalUrl: `${API}/device/approve/apr_m` } });

    const out = await call({ action: "mint-signing", store: "safari" });

    expect(out.status).toBe("approval-required");
    expect(out.value.approvalId).toBe("apr_m");
    expect(out.value.trackUrl).toBe(`${API}/device/approve/apr_m`);
    expect(out.value.checkUrl).toContain(STORE_SETTINGS_PAGE);
    expect(platform.sent("POST", APPROVALS)[0].body).toMatchObject({ action: "extension_store.mint", scope: SCOPE });
    expect(platform.sent("POST", MINT)).toHaveLength(1);
    expect(platform.sent("POST", MINT)[0].body.approvalId).toBeUndefined();
    expect(platform.calls.filter((sent) => sent.path.endsWith("/stores/config"))).toHaveLength(0);
  });

  it("604: a mint the lane does not run names the Apple Developer hand path as the next step and asks for nothing", async () => {
    const handPath = "open Certificates, Identifiers and Profiles in the Apple Developer account and create the signing certificate and provisioning profile";
    const message = `Minting App Store signing assets does not run on the extension.dev lane yet, so nothing was minted and no approval was asked for or spent. To do it now, ${handPath}.`;
    platform.login();
    platform.routes[`POST ${MINT}`] = () => ({
      status: 409,
      body: { code: "STORE_ACT_NOT_ON_LANE", store: "safari", act: "mint", handPath, refusedBeforeApproval: true, message },
    });

    const out = await call({ action: "mint-signing", store: "safari" });

    expect(out.status).toBe("mint-signing-refused");
    expect(out.error).toMatchObject({ platformCode: "STORE_ACT_NOT_ON_LANE", message });
    expect(out.value).toMatchObject({ owner: "store", handPath, sayToPerson: message, refusedBeforeApproval: true });
    expect(out.value.nextStep).toEqual({ kind: "dashboard", say: message, url: null });
    expect(out.hint.startsWith(message)).toBe(true);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });

  it("answers mint-dispatched with the record's fields and the track page once the approvalId is carried", async () => {
    platform.login();
    platform.routes[`POST ${MINT}`] = () => ({ status: 202, body: DISPATCHED });
    platform.routes[CONFIG] = () => ({ body: { safari: { bundleId: "com.acme.widget", mint: { dispatchId: "d-mint-1", runState: "queued" } } } });

    const out = await call({ action: "mint-signing", approvalId: "apr_m", waitSeconds: 0 });

    expect(platform.sent("POST", MINT)[0].body).toMatchObject({ approvalId: "apr_m", origin: "mcp" });
    expect(out.status).toBe("mint-dispatched");
    expect(out.value).toMatchObject({
      action: "mint-signing",
      store: "safari",
      bundleId: "com.acme.widget",
      settingsFilled: ["bundleId"],
      dispatchId: "d-mint-1",
      dispatchedAt: "2026-11-06T20:00:00.000Z",
      usualSeconds: 180,
      runCorrelation: "corr-1",
      approvalId: "apr_m",
    });

    expect(out.value.trackUrl).toContain(STORE_SETTINGS_PAGE);
    expect(out.value.outcome).toMatchObject({ recorded: false, source: "platform-record" });
    expect(out.value.nextStep.kind).toBe("watch");
  });

  it("answers minted once the record of the same dispatch reads landed", async () => {
    platform.login();
    platform.routes[`POST ${MINT}`] = () => ({ status: 202, body: DISPATCHED });
    platform.routes[CONFIG] = () => ({ body: { safari: { bundleId: "com.acme.widget", mint: { dispatchId: "d-mint-1", runState: "landed" } } } });

    const out = await call({ action: "mint-signing", store: "safari", approvalId: "apr_m" });

    expect(out.status).toBe("minted");
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "minted" });
  });

  it("answers a rate-limit refusal with the wait the platform asks for", async () => {
    platform.login();
    platform.routes[`POST ${MINT}`] = () => ({
      status: 429,
      headers: { "Retry-After": "42" },
      body: { code: "RATE_LIMITED", message: "Too many mint requests. Wait 42 seconds and try again.", retryAfterSeconds: 42 },
    });

    const out = await call({ action: "mint-signing", store: "safari" });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("rate-limited");
    expect(out.error.platformCode).toBe("RATE_LIMITED");
    expect(out.value.retryAfterSeconds).toBe(42);
    expect(out.hint).toContain("after 42 seconds");
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });

  it("refuses a store other than Safari before anything is sent", async () => {
    platform.login();

    const out = await call({ action: "mint-signing", store: "chrome" });

    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("MintNotApplicable");
    expect(out.error.message).toContain("does not apply to chrome");
    expect(platform.calls).toHaveLength(0);
  });
});

describe("the preflight readiness BUILD group reads Browser builds and the saved bundle id", () => {
  const platform = useProjectRoutes("extdev-build-readiness-");

  function settings(on: Record<string, boolean>): Row {
    return { enabledBrowsers: on };
  }

  async function preflight(on: Record<string, boolean>, safariConfig: Row | null): Promise<Row> {
    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/stores/chrome/submissions/preflight`] = () => ({ body: structuredClone(WALK.chrome) });
    platform.routes[`POST ${PROJECT_ROUTE}/stores/safari/submissions/preflight`] = () => ({ body: structuredClone(WALK.safari) });
    platform.routes[SETTINGS] = () => ({ body: settings(on) });
    if (safariConfig) platform.routes[CONFIG] = () => ({ body: { safari: safariConfig } });

    return JSON.parse(await submit({ action: "preflight", browsers: ["chrome", "safari"], detail: true, api: API }));
  }

  const rowOf = (out: Row, store: string, id: string): Row | undefined => (out.value.stores[store].requirements.items as Row[]).find((row) => row.id === id);

  it("fails <store>.browser_builds in the build group when the project builds that browser off", async () => {
    const out = await preflight({ chrome: false, safari: true }, { bundleId: "com.acme.widget" });

    expect(rowOf(out, "chrome", "chrome.browser_builds")).toMatchObject({ status: "missing", required: true, actual: "Chrome builds are off for this project, so no build carries a chrome artifact." });
    expect(rowOf(out, "chrome", "chrome.browser_builds")!.how).toContain('extension_builds {action: "configure", buildSettings: {chrome: {enabled: true}}}');
    expect(out.value.readiness.build.required).toContain("chrome.browser_builds");
    expect(out.value.readiness.build.required ?? []).not.toContain("safari.browser_builds");
  });

  it("passes <store>.browser_builds when the browser is on", async () => {
    const out = await preflight({ chrome: true, safari: true }, { bundleId: "com.acme.widget" });

    expect(rowOf(out, "chrome", "chrome.browser_builds")).toMatchObject({ status: "have" });
    expect(rowOf(out, "safari", "safari.browser_builds")).toMatchObject({ status: "have" });
    expect(JSON.stringify(out.value.readiness.build ?? {})).not.toContain("browser_builds");
  });

  it("reports safari.bundle_id_registered configured from the saved settings, leaving registration to the mint", async () => {
    const out = await preflight({ chrome: true, safari: true }, { bundleId: "com.acme.widget", registered: false });
    const row = rowOf(out, "safari", "safari.bundle_id_registered")!;

    expect(row).toMatchObject({ status: "have", actual: "com.acme.widget is configured; registration is checked at mint" });
    expect(row.how).toContain('extension_submit {action: "mint-signing", store: "safari"}');
    expect(JSON.stringify(out.value.readiness.build ?? {})).not.toContain("safari.bundle_id_registered");
  });

  it("reports safari.bundle_id_registered missing in the build group when no bundle id is saved", async () => {
    const out = await preflight({ chrome: true, safari: true }, { bundleId: "" });
    const row = rowOf(out, "safari", "safari.bundle_id_registered")!;

    expect(row).toMatchObject({ status: "missing", required: true });
    expect(row.actual).toContain("registration is checked at mint");
    expect(out.value.readiness.build.required).toContain("safari.bundle_id_registered");
  });
});
