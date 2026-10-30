import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { writeCredentials } from "../lib/credentials";
import { handler as submit } from "../tools/submit";
import { digestOf } from "./fixtures/listing-digest";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const ID = `apr_${"P".repeat(32)}`;
const READ = `/api/cli/approvals/${ID}`;
const APPROVALS = "/api/cli/approvals";
const SHA = "b418732";
const PUBLISH = (store: string) => `${PROJECT_ROUTE}/stores/${store}/publish`;
const LISTING = (store: string) => `${PROJECT_ROUTE}/stores/${store}/listing`;
const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const EDGE_LOCK = {
  kind: "review-in-progress",
  storeWord: "InProgressSubmission",
  clearsWhen: "Microsoft finishes certifying 0.2.0.7",
  readAt: "2026-10-28T12:00:00.000Z",
};

type Line = { id: string; store: string; act: string; state: string };

const line = (store: string, act: string, state = "pending"): Line => ({ id: `${store}:${act}`, store, act, state });

const versionFingerprint = (acts: string[], buildSha = SHA, listings: string[] = []) =>
  actionFingerprint("extension_submit.version", {
    acts: [...acts].sort(),
    buildSha,
    ...(listings.length ? { listings: [...listings].sort() } : {}),
    version: "",
  });

const minted = (lines: Line[]) => ({
  status: 201,
  body: {
    approvalId: ID,
    approvalUrl: `${API}/device/approve/${ID}`,
    expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
    description: "Send the drafts to review.",
    lines,
  },
});

const approved = (lines: Line[], fingerprint: string) => ({
  body: {
    status: "approved",
    fingerprint,
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    used: false,
    approver: "octocat",
    lines,
  },
});

describe("a publish naming several stores is one approval per version", () => {
  const platform = useProjectRoutes("extdev-publish-version-");

  it("needs the build whose drafts it sends and asks nothing without it", async () => {
    platform.login();

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome", "edge"], api: API }));

    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("pass buildSha");
    expect(platform.calls.filter((call) => call.path !== "/api/cli/whoami")).toHaveLength(0);
  });

  it("asks for one version approval with a publish line per store and says a store can be left out", async () => {
    platform.login();
    platform.routes[`POST ${APPROVALS}`] = () => minted([line("chrome", "publish"), line("edge", "publish")]);

    const out = JSON.parse(await submit({ action: "publish", browsers: ["edge", "chrome"], buildSha: SHA, api: API }));
    const sent = platform.sent("POST", APPROVALS)[0]!.body;

    expect(sent.action).toBe("extension_submit.version");
    expect(sent.scope).toEqual({ acts: ["chrome:publish", "edge:publish"], buildSha: SHA, version: "" });
    expect(sent.fingerprint).toBe(versionFingerprint(["chrome:publish", "edge:publish"]));
    expect(out.status).toBe("approval-required");
    expect(out.value.nextStep.say).toContain("uncheck a store to leave it out");
    expect(platform.sent("POST", PUBLISH("chrome"))).toHaveLength(0);
  });

  it("sends each store's draft on its own route and reports a queued line apart from a spent one", async () => {
    platform.login();
    platform.routes[`GET ${READ}`] = () =>
      approved([line("chrome", "publish"), line("edge", "publish")], versionFingerprint(["chrome:publish", "edge:publish"]));

    platform.routes[`POST ${PUBLISH("edge")}`] = () => ({
      status: 202,
      body: {
        ok: true,
        status: "publish-queued",
        store: "edge",
        queued: { message: "Queued until Microsoft finishes certifying 0.2.0.7." },
        approvalId: ID,
        lines: [line("edge", "publish", "queued")],
      },
    });

    platform.routes[`POST ${PUBLISH("chrome")}`] = () => ({
      body: { ok: true, dispatched: true, store: "chrome", submissionId: "sub_c", approvalId: ID, lines: [line("chrome", "publish", "spent")] },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["edge", "chrome"], buildSha: SHA, approvalId: ID, api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("publish-dispatched");
    expect(out.value.stores.edge).toMatchObject({ status: "publish-queued", message: "Queued until Microsoft finishes certifying 0.2.0.7." });
    expect(out.value.lines.map((row: Line) => [row.store, row.state])).toEqual([
      ["edge", "queued"],
      ["chrome", "spent"],
    ]);

    expect(platform.sent("POST", PUBLISH("edge"))[0]!.body).toEqual({ approvalId: ID });
    expect(out.hint).toContain("edge: queued behind the store's review, its line still pending");
  });

  it("names the store to retry when a refused dispatch gave its line back, and the one the owner left out", async () => {
    platform.login();
    platform.routes[`GET ${READ}`] = () =>
      approved([line("chrome", "publish", "denied"), line("edge", "publish")], versionFingerprint(["chrome:publish", "edge:publish"]));

    platform.routes[`POST ${PUBLISH("chrome")}`] = () => ({
      status: 403,
      body: { code: "APPROVAL_LINE_DENIED", message: "The owner left chrome out of this approval, so nothing ran for it.", lines: [line("chrome", "publish", "denied")] },
    });

    platform.routes[`POST ${PUBLISH("edge")}`] = () => ({
      status: 502,
      body: { code: "PUBLISH_DISPATCH_FAILED", message: "The platform could not start the Edge review run.", approvalRefunded: true, lines: [line("edge", "publish", "refunded")] },
    });

    const both = JSON.parse(await submit({ action: "publish", browsers: ["chrome", "edge"], buildSha: SHA, approvalId: ID, api: API }));

    expect(both.ok).toBe(false);
    expect(both.status).toBe("publish-failed");
    expect(both.value.lines.map((row: Line) => [row.store, row.state])).toEqual([
      ["chrome", "denied"],
      ["edge", "refunded"],
    ]);

    expect(both.hint).toContain(`approvalId ${ID} and browsers limited to edge`);
    expect(both.hint).toContain("chrome: left out by the owner");
  });
});

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-listing-version-"));
  fs.writeFileSync(path.join(root, "STORE.md"), "# Store metadata\n\n## Listing\n\n- Name: PII Shield\n- Summary: Hide personal information on every open tab with one click.\n");

  return root;
}

function loginWithClaims(): void {
  const exp = Math.floor(Date.now() / 1000) + 3600;

  writeCredentials({
    version: 1,
    token: `${Buffer.from(JSON.stringify({ u: "acme", p: "widget", exp })).toString("base64url")}.sig`,
    workspaceSlug: "acme",
    projectSlug: "widget",
    expiresAt: exp,
    api: API,
  });
}

describe("a sync-listing whose stores the platform asks an owner for is one approval", () => {
  const platform = useProjectRoutes("extdev-listing-version-");
  let root = "";

  beforeEach(() => {
    root = project();
  });

  const askingListing = (store: string) => (call: { body: any }) => {
    if (call.body.approvalId) {
      return { body: { ok: true, store, changes: ['title: "" -> "PII Shield"'], lines: [line(store, "sync-listing", "spent")] } };
    }

    const scope = { store, listingDigest: digestOf(call.body) };

    return {
      status: 403,
      body: {
        code: "APPROVAL_REQUIRED",
        message: "Needs approval.",
        approvalRequest: { action: "extension_store.listing", scope, fingerprint: actionFingerprint("extension_store.listing", scope) },
      },
    };
  };

  it("gathers the stores that asked into one version grant bound to each store's digest, then writes each once with it", async () => {
    if (process.platform === "win32") return;

    loginWithClaims();
    platform.routes[`PUT ${LISTING("chrome")}`] = askingListing("chrome");
    platform.routes[`PUT ${LISTING("edge")}`] = askingListing("edge");
    platform.routes[`POST ${APPROVALS}`] = () => minted([line("chrome", "sync-listing"), line("edge", "sync-listing")]);
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: { checks: [] } });
    platform.routes[`POST ${PREFLIGHT("edge")}`] = () => ({ body: { checks: [] } });

    const asked = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome", "edge"], projectPath: root, api: API }));
    const request = platform.sent("POST", APPROVALS);
    const firstPut = platform.sent("PUT", LISTING("chrome"))[0]!.body;
    const digest = digestOf(firstPut);

    expect(request).toHaveLength(1);
    expect(request[0]!.body.action).toBe("extension_submit.version");
    expect(request[0]!.body.scope).toEqual({
      acts: ["chrome:sync-listing", "edge:sync-listing"],
      buildSha: "",
      listings: [`chrome:${digest}`, `edge:${digestOf(platform.sent("PUT", LISTING("edge"))[0]!.body)}`].sort(),
      version: "",
    });

    expect(Object.keys(request[0]!.body.listings).sort()).toEqual(["chrome", "edge"]);
    expect(request[0]!.body.listings.chrome.listing.title).toBe("PII Shield");
    expect(asked.status).toBe("approval-required");
    expect(asked.value.approvalId).toBe(ID);
    expect(asked.hint).toContain("one page lists the chrome, edge listings, one line per store");

    platform.routes[`GET ${READ}`] = () =>
      approved([line("chrome", "sync-listing"), line("edge", "sync-listing")], request[0]!.body.fingerprint);

    const written = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome", "edge"], projectPath: root, approvalId: ID, api: API }));

    expect(written.status).toBe("listing-synced");
    expect(platform.sent("PUT", LISTING("chrome")).slice(-1)[0]!.body.approvalId).toBe(ID);
    expect(written.value.lines.map((row: Line) => [row.store, row.state])).toEqual([
      ["chrome", "spent"],
      ["edge", "spent"],
    ]);
  });

  it("reports a store the owner left out without failing the stores that were written", async () => {
    if (process.platform === "win32") return;

    loginWithClaims();
    platform.routes[`PUT ${LISTING("chrome")}`] = askingListing("chrome");
    platform.routes[`PUT ${LISTING("edge")}`] = askingListing("edge");
    platform.routes[`POST ${APPROVALS}`] = () => minted([line("chrome", "sync-listing"), line("edge", "sync-listing")]);
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: { checks: [] } });

    await submit({ action: "sync-listing", browsers: ["chrome", "edge"], projectPath: root, api: API });

    platform.routes[`PUT ${LISTING("edge")}`] = () => ({
      status: 403,
      body: { code: "APPROVAL_LINE_DENIED", message: "The owner left edge out of this approval, so nothing ran for it.", lines: [line("edge", "sync-listing", "denied")] },
    });

    const written = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome", "edge"], projectPath: root, approvalId: ID, api: API }));

    expect(written.ok).toBe(true);
    expect(written.status).toBe("listing-recorded");
    expect(written.value.stores.chrome.status).toBe("recorded");
    expect(written.value.stores.edge).toMatchObject({ status: "left-out", code: "APPROVAL_LINE_DENIED" });
    expect(written.hint).toContain("edge: left out by the owner");
  });
});

describe("the preflight view keeps a locked check's lock and each store's block", () => {
  const platform = useProjectRoutes("extdev-preflight-lock-");

  it("answers the lock beside the check, never as a failure, and names what clears it in the hint", async () => {
    platform.login();
    platform.routes[`POST ${PREFLIGHT("edge")}`] = () => ({
      body: {
        store: "edge",
        summary: { pass: 1, warn: 0, fail: 0, blockingFailures: 0, canSubmit: true },
        checks: [
          { id: "manifest", label: "Manifest", status: "pass", severity: "blocking" },
          { id: "edge.review_in_progress", label: "Review in progress", status: "locked", severity: "blocking", message: "Partner Center is reviewing 0.2.0.7.", lock: EDGE_LOCK },
        ],
        edgePreflight: {
          act: "publish",
          checks: [],
          blocking: [],
          warnings: ["edge.description_length"],
          lock: EDGE_LOCK,
          inFlight: { version: "0.2.0.7" },
          approval: "Publish is queued behind version 0.2.0.7, which Partner Center is reviewing.",
        },
      },
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["edge"], buildSha: SHA, api: API }));

    expect(out.value.stores.edge.failing).toEqual([]);
    expect(out.value.stores.edge.locked).toEqual([
      expect.objectContaining({ id: "edge.review_in_progress", status: "locked", lock: EDGE_LOCK }),
    ]);

    expect(out.value.storePreflight.edge).toEqual({
      act: "publish",
      blocking: [],
      warnings: ["edge.description_length"],
      checks: [
        {
          id: "edge.description_length",
          label: "edge.description_length",
          status: "fail",
          actual: "the platform's store preflight named it without a reason: POST stores/edge/submissions/preflight listed it in edgePreflight.warnings with no row of that id in edgePreflight.checks",
          expected: "a row in edgePreflight.checks with the rule's label, expected, actual and what to do",
        },
      ],
      lock: EDGE_LOCK,
      approval: "Publish is queued behind version 0.2.0.7, which Partner Center is reviewing.",
    });

    expect(out.hint).toContain("edge: the publish is locked until Microsoft finishes certifying 0.2.0.7 (InProgressSubmission)");
  });
});
