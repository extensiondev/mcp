// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = `${PROJECT_ROUTE}/stores/firefox/submissions/preflight`;
const CONNECT_URL = "http://console.extension.localhost/acme/widget/project-settings/stores?connect=firefox";
const AMO_KEY_PAGE = "https://addons.mozilla.org/developers/addon/api/key/";
const AMO_DETAIL = 'Invalid Firefox credentials: AMO answered 401 "Error decoding signature." (the JWT issuer or secret is wrong, or the secret was rotated).';
const UNVERIFIED_MESSAGE = "The AMO key pair has not been verified; connect Firefox Add-ons once in project settings so the key is checked before an upload.";
const CHECKED_AT = "2026-10-23T15:07:00.000Z";

type Check = Record<string, unknown>;

function check(id: string, status: "pass" | "fail" | "warn", message: string, extra: Check = {}): Check {
  return { id, status, severity: status === "warn" ? "warning" : "blocking", stage: "integration", ownership: "automated", message, ...extra };
}

const GREEN: Check[] = [
  check("submission.release_selected", "pass", "Release context detected."),
  check("submission.build_selected", "pass", "Build artifact selected."),
  check("store.enabled", "pass", "Store publishing is enabled."),
  check("store.config_present", "pass", "Firefox add-on identity is configured."),
  check("listing.title_present", "pass", "Listing title is present.", { stage: "review" }),
];

function report(args: { credentials: Check; connection: Record<string, unknown>; mode?: "listed" | "unlisted" }) {
  const checks = [...GREEN, args.credentials];
  const fail = checks.filter((c) => c.status === "fail").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const mode = args.mode ?? "unlisted";

  return {
    store: "firefox",
    summary: { pass: checks.length - fail - warn, warn, fail, blockingFailures: fail, canSubmit: fail === 0 },
    submissionMode: { id: mode, label: mode === "listed" ? "Listed" : "Unlisted", description: mode === "listed" ? "Enters the public review flow." : "Signed for self distribution." },
    checks,
    connection: args.connection,
    connectUrl: CONNECT_URL,
  };
}

const FAILED = report({
  credentials: check("store.credentials_present", "fail", `AMO refused the saved key pair (${AMO_DETAIL.replace(/\.$/, "")}): the issuer and secret do not match; re-copy both from ${AMO_KEY_PAGE}.`, { actual: AMO_DETAIL, docsUrl: CONNECT_URL }),
  connection: { kind: "jwt", connectedAs: "user:12345:67", connectedAt: CHECKED_AT, checkedAt: CHECKED_AT, healthy: false, reason: AMO_DETAIL },
});

const UNVERIFIED_CONNECTION = { kind: "jwt", connectedAs: null, connectedAt: null, checkedAt: null, healthy: null };

const UNVERIFIED_LISTED = report({
  credentials: check("store.credentials_present", "fail", UNVERIFIED_MESSAGE, { actual: "unverified", docsUrl: CONNECT_URL }),
  connection: UNVERIFIED_CONNECTION,
  mode: "listed",
});

const UNVERIFIED_UNLISTED = report({
  credentials: check("store.credentials_present", "warn", UNVERIFIED_MESSAGE, { actual: "unverified", docsUrl: CONNECT_URL }),
  connection: UNVERIFIED_CONNECTION,
});

const VERIFIED = report({
  credentials: check("store.credentials_present", "pass", `The AMO key pair was verified against addons.mozilla.org on ${CHECKED_AT} for user:12345:67.`),
  connection: { kind: "jwt", connectedAs: "user:12345:67", connectedAt: CHECKED_AT, checkedAt: CHECKED_AT, healthy: true },
});

describe("a Firefox preflight answers the AMO key pair's state the way it answers the Chrome connection", () => {
  const platform = useProjectRoutes("extdev-firefox-key-pair-");

  it("a pair AMO refused answers store-connection-failed with AMO's detail, the re-copy sentence and the connect page", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: FAILED });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "603fc8a", api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("store-connection-failed");
    expect(out.value.connectUrl).toBe(CONNECT_URL);
    expect(out.value.trackUrl).toMatch(/\/project-settings\/stores$/);
    expect(out.value.nextStep).toEqual({ kind: "connect", say: out.hint, url: CONNECT_URL });
    expect(out.value.sayToPerson).toBe(out.hint);
    expect(out.hint).toContain(`Your Firefox AMO connection failed its last check: ${AMO_DETAIL.replace(/\.$/, "")}.`);
    expect(out.hint).toContain('AMO answered 401 "Error decoding signature."');
    expect(out.hint).toContain(`The issuer and secret do not match; re-copy both from ${AMO_KEY_PAGE}`);
    expect(out.hint).toContain(CONNECT_URL);
    expect(out.hint).not.toContain("Chrome Web Store");
    expect(out.value.stores.firefox.canSubmit).toBe(false);
    expect(out.value.stores.firefox.failing.map((c: { id: string }) => c.id)).toEqual(["store.credentials_present"]);
    expect(out.warnings).toContain("This read wrote nothing.");
    expect(JSON.stringify(out)).not.toContain("STORE_FIREFOX_API_KEY");
    expect(JSON.stringify(out)).not.toContain("STORE_FIREFOX_API_SECRET");
  });

  it("a pair no store has answered for answers store-connection-unverified; on the listed channel the platform refuses the upload", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: UNVERIFIED_LISTED });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "603fc8a", api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("store-connection-unverified");
    expect(out.value.connectUrl).toBe(CONNECT_URL);
    expect(out.value.trackUrl).toMatch(/\/project-settings\/stores$/);
    expect(out.value.nextStep).toEqual({ kind: "connect", say: out.hint, url: CONNECT_URL });
    expect(out.value.sayToPerson).toBe(out.hint);
    expect(out.hint).toBe(
      `The AMO key pair saved for this project has not been checked against Mozilla, so the platform refuses the upload until it is. Connect Firefox Add-ons once at ${CONNECT_URL}: the console checks the issuer and secret against AMO before it saves them. Then say preflight again.`,
    );

    expect(out.hint).not.toContain(AMO_KEY_PAGE);
    expect(out.value.stores.firefox.canSubmit).toBe(false);
  });

  it("on the unlisted channel the unverified pair says the approval is what an AMO refusal would spend", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: UNVERIFIED_UNLISTED });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("store-connection-unverified");
    expect(out.hint).toContain("so an upload can fail at AMO after the owner's approval is spent");
    expect(out.value.nextStep.kind).toBe("connect");
    expect(out.value.stores.firefox.canSubmit).toBe(true);
    expect(out.value.stores.firefox.warnings.map((c: { id: string }) => c.id)).toEqual(["store.credentials_present"]);
  });

  it("a verified pair keeps the plain readiness answer with submit as the next step", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: VERIFIED });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("preflight-read");
    expect(out.value.nextStep.kind).toBe("submit");
    expect(out.value.stores.firefox.connection).toMatchObject({ kind: "jwt", healthy: true, connectedAs: "user:12345:67" });
    expect(out.hint).not.toContain("key pair");
  });
});

describe("a real submit reads the same Firefox verdict before any approval", () => {
  it("turns a failed Firefox connection into the key pair sentences, and names Edge for Edge", async () => {
    const { connectionStep, rowFromConnection } = await import("../lib/store-readiness");
    const connection = { kind: "jwt", connectedAs: "user:12345:67", healthy: false, itemId: null, reason: AMO_DETAIL, connectUrl: CONNECT_URL };
    const row = rowFromConnection("firefox", connection);

    expect(row.state).toBe("store-connection-failed");
    expect(row.reason).toBe(`Your Firefox AMO connection failed its last check: ${AMO_DETAIL.replace(/\.$/, "")}.`);

    const step = connectionStep(row, connection, { ref: { workspace: "acme", project: "widget" }, api: API });

    expect(step.kind).toBe("connect");
    expect(step.url).toBe(CONNECT_URL);
    expect(step.say).toContain(row.reason);
    expect(step.say).toContain(`re-copy both from ${AMO_KEY_PAGE}`);
    expect(step.say).toContain(CONNECT_URL);
    expect(step.say).not.toContain("Chrome Web Store");

    expect(rowFromConnection("edge", { kind: "apiKey", connectedAs: null, healthy: false, itemId: null, reason: "Unauthorized." }).reason).toBe("Your Edge Add-ons connection failed its last check: Unauthorized.");
    expect(rowFromConnection("chrome", { kind: "oauth", connectedAs: null, healthy: false, itemId: null, reason: "token revoked" }).reason).toBe("Your Chrome Web Store connection failed its last check: token revoked.");
    expect(rowFromConnection("firefox", { kind: "jwt", connectedAs: null, healthy: null, itemId: null }).state).toBe("not-checked");
  });
});
