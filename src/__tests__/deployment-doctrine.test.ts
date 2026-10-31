// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEPLOYMENT_DOCTRINE, serverInstructions } from "../index";
import { actionFingerprint } from "../lib/approval-gate";
import { APPROVAL_OPENED_SENTENCE, canAutoOpen, forgetOpenedApprovals, openApprovalOnce, osOpenCommand, setApprovalOpener } from "../lib/approval-open";
import { envelope } from "../lib/envelope";
import { RESUBMIT_SENTENCE, shapeStoreAnswer } from "../lib/store-answer";
import { WORLD_API, WORLD_PROJECT_ID, usePlatformWorld } from "./fixtures/platform-world";

const PLATFORM_ON = { features: ["local", "platform"] as Array<"local" | "platform">, noShip: false };
const PREFLIGHT = new RegExp(`^POST /api/projects/${WORLD_PROJECT_ID}/stores/chrome/submissions/preflight$`);
const SUBMIT = /^POST \/api\/cli\/stores\/submit$/;
const SUBMIT_ARGS = { action: "submit", browsers: ["chrome"], buildSha: "603fc8a", dryRun: false, api: WORLD_API };
const DESKTOP = { HOME: "/Users/person" };
const ORDER = [
  "Anything that leaves the person's machine goes through extension.dev",
  "extension_build is for the person's own machine only",
  "A store's version refusal is the platform's to absorb",
  "After any stop that asked the person for one action (connect, link, approve)",
];

function approvalAnswer(approvalId: string): string {
  return envelope({
    ok: false,
    command: "extension_submit",
    status: "approval-required",
    error: { code: "E_APPROVAL_REQUIRED", message: "A workspace owner approves this submission first." },
    value: { approvalId, approvalUrl: `${WORLD_API}/device/approve/${approvalId}`, expiresAt: "2026-10-19T21:00:00.000Z" },
    hint: `Approve at ${WORLD_API}/device/approve/${approvalId}.`,
  });
}

function approved(world: ReturnType<typeof usePlatformWorld>, approvalId: string): void {
  world.routes.push([
    new RegExp(`^GET /api/cli/approvals/${approvalId}$`),
    () => ({
      body: {
        status: "approved",
        used: false,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        fingerprint: actionFingerprint("extension_submit", { browsers: ["chrome"], buildSha: "603fc8a" }),
      },
    }),
  ]);
}

describe("the deployment doctrine sits in the server instructions, in order, beside the extension.dev-first rule", () => {
  const text = serverInstructions(PLATFORM_ON);
  const lines = text.split("\n");

  it("carries four lines between the extension.dev-first line and the Chrome goal playbook", () => {
    expect(DEPLOYMENT_DOCTRINE.length).toBeLessThan(8);

    const first = lines.findIndex((line) => line.includes("lead with extension.dev"));
    const goal = lines.findIndex((line) => line.startsWith("Chrome Web Store goal:"));
    let at = first;

    for (const opening of ORDER) {
      const next = lines.findIndex((line) => line.startsWith(opening));

      expect(next, opening).toBeGreaterThan(at);
      at = next;
    }

    expect(at).toBeLessThan(goal);
  });

  it("routes everything that leaves the machine to the platform build, extension_publish and extension_submit, with stores only on demand", () => {
    const rule = lines.find((line) => line.startsWith(ORDER[0])) ?? "";

    expect(rule).toMatch(/platform build \(extension_builds\)/);
    expect(rule).toMatch(/links from extension_publish/);
    expect(rule).toMatch(/stores from extension_submit/);
    expect(rule).toMatch(/a store is touched only when the person asks for a store/);
  });

  it("answers 'give me the zip to send to my tester' with the platform, never the extension_build output", () => {
    const rule = lines.find((line) => line.startsWith(ORDER[1])) ?? "";

    expect(rule).toMatch(/never offer its output, a zip or a dist folder/);

    for (const word of ["share", "send", "test with someone", "submit"]) {
      expect(rule).toContain(word);
    }

    expect(rule).toMatch(/route to the platform, a link from extension_publish or a store act from extension_submit/);
  });

  it("keeps a store version refusal on the platform and re-runs preflight after a one-action stop", () => {
    const version = lines.find((line) => line.startsWith(ORDER[2])) ?? "";
    const resume = lines.find((line) => line.startsWith(ORDER[3])) ?? "";

    expect(version).toMatch(/never tell the person to edit the manifest and rebuild locally/);
    expect(resume).toMatch(/the next message re-runs extension_submit action:'preflight' without being told/);
  });

  it("is absent when the platform tools are off", () => {
    expect(serverInstructions()).not.toContain(ORDER[0]);
  });

  it("the Chrome goal playbook calls preflight on the next message instead of waiting to be told", () => {
    expect(text).not.toMatch(/says they are back|say they connected/);

    for (const step of ["2. On store-not-connected", "3. On store-item-not-linked"]) {
      const line = lines.find((entry) => entry.startsWith(step)) ?? "";

      expect(line, step).toContain("on the person's next message, call preflight again.");
    }
  });
});

describe("a connect or link stop hands the agent the call to make next", () => {
  const world = usePlatformWorld("extdev-doctrine-next-");

  it.each([
    ["store-not-connected", "connect", { kind: null, connectedAs: null, healthy: null, itemId: null, connectUrl: "http://console.extension.localhost/acme/widget/project-settings/stores?connect=chrome" }],
    ["store-item-not-linked", "link-item", { kind: "oauth", connectedAs: "cezar@example.com", healthy: true, itemId: null, itemLinked: false }],
  ])("%s answers nextStep.thenCall preflight for the same browsers", async (status, kind, connection) => {
    if (process.platform === "win32") return;

    world.login();
    world.routes.push([PREFLIGHT, () => ({ body: { store: "chrome", summary: { pass: 0, warn: 0, fail: 1, canSubmit: false }, checks: [], connection } })]);

    const out = await world.call("extension_submit", { action: "preflight", browsers: ["chrome"], api: WORLD_API });

    expect(out.status).toBe(status);
    expect(out.value.nextStep.kind).toBe(kind);
    expect(out.value.nextStep.thenCall).toEqual({ tool: "extension_submit", args: { action: "preflight", browsers: ["chrome"] } });
  });

  it("a real submission refused as not connected carries the same thenCall", async () => {
    if (process.platform === "win32") return;

    world.login();
    approved(world, "apr_conn");
    world.routes.push([SUBMIT, () => ({ status: 409, body: { code: "STORE_NOT_CONNECTED", message: "Connect the Chrome Web Store first." } })]);

    const out = await world.call("extension_submit", { ...SUBMIT_ARGS, approvalId: "apr_conn" });

    expect(out.status).toBe("store-not-connected");
    expect(out.value.nextStep.thenCall).toEqual({ tool: "extension_submit", args: { action: "preflight", browsers: ["chrome"] } });
  });
});

describe("an approval page opens itself once in the person's browser", () => {
  const world = usePlatformWorld("extdev-doctrine-open-");
  const opened: string[] = [];
  let restore: () => void = () => undefined;

  beforeEach(() => {
    opened.length = 0;
    forgetOpenedApprovals();
    restore = setApprovalOpener((url) => {
      opened.push(url);

      return true;
    });

    vi.stubEnv("CI", "");
    vi.stubEnv("EXTENSION_HEADLESS", "");
    vi.stubEnv("EXTENSION_BROWSER_FLAGS", "");
    vi.stubEnv("EXTENSION_DEV_NO_AUTO_OPEN", "");
    vi.stubEnv("DISPLAY", ":0");
  });

  afterEach(() => {
    restore();
    vi.unstubAllEnvs();
  });

  it("opens value.approvalUrl once through the local server and says so in the hint", async () => {
    if (process.platform === "win32") return;

    world.login();
    world.routes.push([/^POST \/api\/cli\/approvals$/, () => ({ body: { approvalId: "apr_open", approvalUrl: `${WORLD_API}/device/approve/apr_open`, expiresAt: "2026-10-19T21:00:00.000Z" } })]);

    const first = await world.call("extension_submit", SUBMIT_ARGS, { openApprovals: true });
    const second = await world.call("extension_submit", SUBMIT_ARGS, { openApprovals: true });

    expect(first.status).toBe("approval-required");
    expect(opened).toEqual([`${WORLD_API}/device/approve/apr_open`]);
    expect(first.hint).toContain(APPROVAL_OPENED_SENTENCE);
    expect(first.value.approvalOpened).toBe(true);
    expect(second.hint ?? "").not.toContain(APPROVAL_OPENED_SENTENCE);
  });

  it("renews an approval the platform reports expired with the same fingerprint, and opens the fresh page once", async () => {
    if (process.platform === "win32") return;

    const fingerprint = actionFingerprint("extension_submit", { browsers: ["chrome"], buildSha: "603fc8a" });
    const expiredAt = "2026-10-19T22:51:00.000Z";
    const freshUrl = `${WORLD_API}/device/approve/apr_fresh`;

    world.login();
    world.routes.push([
      /^GET \/api\/cli\/approvals\/apr_old$/,
      () => ({ status: 410, body: { code: "APPROVAL_EXPIRED", message: `This approval expired at ${expiredAt}`, expiresAt: expiredAt, kind: "extension_submit", fingerprint } }),
    ]);

    world.routes.push([/^POST \/api\/cli\/approvals$/, () => ({ body: { approvalId: "apr_fresh", approvalUrl: freshUrl, expiresAt: "2026-10-19T23:30:00.000Z" } })]);

    const out = await world.call("extension_submit", { ...SUBMIT_ARGS, approvalId: "apr_old" }, { openApprovals: true });
    const minted = world.calls.filter((call) => call.method === "POST" && call.path === "/api/cli/approvals");

    expect(out.status).toBe("approval-required");
    expect(minted).toHaveLength(1);
    expect((minted[0].body as { fingerprint?: string }).fingerprint).toBe(fingerprint);
    expect(out.value).toMatchObject({
      approvalId: "apr_fresh",
      approvalUrl: freshUrl,
      expiresAt: "2026-10-19T23:30:00.000Z",
      fingerprint,
      expiredApproval: { approvalId: "apr_old", status: "approval-expired", expiresAt: expiredAt },
      nextStep: { kind: "approve", url: freshUrl },
      approvalOpened: true,
    });

    expect(typeof out.value.trackUrl).toBe("string");
    expect(out.value.trackUrl).toMatch(/^https?:\/\//);
    expect(out.hint).toContain(`That approval expired at ${expiredAt}; here is a fresh one: ${freshUrl}. Click Approve, then tell me.`);
    expect(out.hint.match(/click approve, then tell me/gi)).toHaveLength(1);
    expect(opened).toEqual([freshUrl]);
    expect(world.calls.some((call) => SUBMIT.test(`${call.method} ${call.path}`))).toBe(false);
  });

  it("never opens from a server built without the local opener, such as the hosted one or a spec", async () => {
    if (process.platform === "win32") return;

    world.login();

    const out = await world.call("extension_submit", SUBMIT_ARGS);

    expect(out.status).toBe("approval-required");
    expect(opened).toEqual([]);
    expect(out.hint ?? "").not.toContain(APPROVAL_OPENED_SENTENCE);
  });

  it("does not open with EXTENSION_DEV_NO_AUTO_OPEN=1", () => {
    vi.stubEnv("EXTENSION_DEV_NO_AUTO_OPEN", "1");

    const out = JSON.parse(openApprovalOnce(approvalAnswer("apr_env"), { noShip: false }));

    expect(opened).toEqual([]);
    expect(out.hint).not.toContain(APPROVAL_OPENED_SENTENCE);
  });

  it("does not open under --no-ship", () => {
    openApprovalOnce(approvalAnswer("apr_noship"), { noShip: true });

    expect(opened).toEqual([]);
  });

  it.each([
    ["headless", { ...DESKTOP, EXTENSION_HEADLESS: "1" }, "darwin"],
    ["headless by flags", { ...DESKTOP, EXTENSION_BROWSER_FLAGS: "--headless=new" }, "darwin"],
    ["CI", { ...DESKTOP, CI: "true" }, "darwin"],
    ["Linux with no display", { ...DESKTOP }, "linux"],
  ] as const)("does not open when %s", (_label, env, platform) => {
    expect(canAutoOpen({ noShip: false }, env, platform)).toBe(false);
    openApprovalOnce(approvalAnswer(`apr_${platform}_${Object.keys(env).join("_")}`), { noShip: false }, env, platform);

    expect(opened).toEqual([]);
  });

  it("opens on a desktop, Linux included when a display is set", () => {
    expect(canAutoOpen({ noShip: false }, DESKTOP, "darwin")).toBe(true);
    expect(canAutoOpen({ noShip: false }, { ...DESKTOP, WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true);
  });

  it("uses the OS opener for each platform", () => {
    expect(osOpenCommand("https://x.test/a", "darwin")).toEqual(["open", ["https://x.test/a"]]);
    expect(osOpenCommand("https://x.test/a", "linux")).toEqual(["xdg-open", ["https://x.test/a"]]);
    expect(osOpenCommand("https://x.test/a?b=1&c=2", "win32")).toEqual(["cmd", ["/c", "start", '""', "https://x.test/a?b=1^&c=2"]]);
  });
});

describe("submit and publish answers carry the platform's store version, and a version refusal answers resubmit", () => {
  const world = usePlatformWorld("extdev-doctrine-version-");
  const storeVersion = { packaged: "1.2.0.7", displayed: "1.2.0", source: "platform" };

  it("passes value.storeVersion through on a submitted answer", async () => {
    if (process.platform === "win32") return;

    world.login();
    approved(world, "apr_ver");
    world.routes.push([SUBMIT, () => ({ body: { ok: true, buildId: "603fc8a", channel: "stable", storeVersion, submissions: [{ id: "sub_1", store: "chrome", status: "pending" }] } })]);

    const out = await world.call("extension_submit", { ...SUBMIT_ARGS, approvalId: "apr_ver" });

    expect(out.status).toBe("submit-dispatched");
    expect(out.value.storeVersion).toEqual(storeVersion);
  });

  it("passes value.storeVersion through on a publish answer and invents none when the platform sends none", () => {
    const withVersion = JSON.parse(shapeStoreAnswer("extension_publish", {}, envelope({ ok: true, command: "extension_publish", status: "published", value: { url: "https://acme.extension.dev/widget", storeVersion: { ...storeVersion, source: "repo", extra: 1 } } })));
    const without = JSON.parse(shapeStoreAnswer("extension_publish", {}, envelope({ ok: true, command: "extension_publish", status: "published", value: { url: "https://acme.extension.dev/widget" } })));
    const malformed = JSON.parse(shapeStoreAnswer("extension_publish", {}, envelope({ ok: true, command: "extension_publish", status: "published", value: { storeVersion: { packaged: "1.2.0.7" } } })));

    expect(withVersion.value.storeVersion).toEqual({ ...storeVersion, source: "repo" });
    expect("storeVersion" in without.value).toBe(false);
    expect("storeVersion" in malformed.value).toBe(false);
  });

  it.each([
    ["STORE_VERSION_NOT_ALLOWED", { code: "STORE_VERSION_NOT_ALLOWED", message: "Version 1.2.0 is not allowed." }],
    ["the store's own message", { code: "STORE_REJECTED", message: "Chrome Web Store: The version of the uploaded package must be greater than the version in the manifest of the published item." }],
  ])("a refusal by %s answers nextStep resubmit and never names the manifest", async (_label, body) => {
    if (process.platform === "win32") return;

    world.login();
    approved(world, "apr_refused");
    world.routes.push([SUBMIT, () => ({ status: 409, body })]);

    const out = await world.call("extension_submit", { ...SUBMIT_ARGS, approvalId: "apr_refused" });

    expect(out.ok).toBe(false);
    expect(out.value.nextStep).toEqual({ kind: "resubmit", say: RESUBMIT_SENTENCE, url: null });
    expect(out.value.trackUrl).toMatch(/\/acme\/widget\/submissions\/chrome$/);
    expect(out.hint).toBe(`${RESUBMIT_SENTENCE} The console page is ${out.value.trackUrl}.`);
    expect(out.value.nextStep.say).toBe("The store already holds that version; extension.dev packages the next build with a higher build number, so build again and I resubmit.");
    expect(`${out.hint} ${out.value.nextStep.say} ${out.value.sayToPerson}`).not.toMatch(/manifest/i);
  });
});
