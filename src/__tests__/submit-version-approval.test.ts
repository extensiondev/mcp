import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { handler as approvals } from "../tools/approvals";
import { handler as submit } from "../tools/submit";
import { API, useProjectRoutes } from "./fixtures/project-routes";

const ID = `apr_${"V".repeat(32)}`;
const READ = `/api/cli/approvals/${ID}`;
const SHA = "abc1234";

type Line = { id: string; store: string; act: string; state: string; line?: string };

const line = (store: string, state = "pending"): Line => ({
  id: `${store}:upload`,
  store,
  act: "upload",
  state,
  line: `Upload build ${SHA} to ${store} as a draft.`,
});

const minted = (lines: Line[]) => ({
  status: 201,
  body: {
    approvalId: ID,
    approvalUrl: `${API}/device/approve/${ID}`,
    expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
    description: `Send build ${SHA} to the stores.`,
    subject: { extension: "Widget", version: "1.4.0", buildSha: SHA },
    lines,
  },
});

const approved = (lines: Line[], scope: Record<string, string | string[]>) => ({
  body: {
    status: "approved",
    fingerprint: actionFingerprint("extension_submit.version", scope),
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    used: lines.every((row) => row.state !== "pending"),
    approver: "octocat",
    lines,
  },
});

const scopeOf = (stores: string[], version = "") => ({
  acts: stores.map((store) => `${store}:upload`).sort(),
  buildSha: SHA,
  version,
});

describe("a real submit naming several stores asks for one approval per version", () => {
  const platform = useProjectRoutes("extdev-version-approval-");

  it("mints the version act with one upload line per store and shows the lines", async () => {
    platform.login();
    platform.routes["POST /api/cli/approvals"] = () => minted([line("chrome"), line("firefox")]);

    const out = JSON.parse(await submit({ browsers: ["firefox", "chrome"], buildSha: SHA, dryRun: false, version: "1.4.0", api: API }));
    const sent = platform.sent("POST", "/api/cli/approvals")[0];

    expect(sent.body.action).toBe("extension_submit.version");
    expect(sent.body.scope).toEqual({ acts: ["chrome:upload", "firefox:upload"], buildSha: SHA, version: "1.4.0" });
    expect(sent.body.fingerprint).toBe(actionFingerprint("extension_submit.version", sent.body.scope));
    expect(out.status).toBe("approval-required");
    expect(out.value.approvalId).toBe(ID);
    expect(out.value.lines.map((row: Line) => row.store)).toEqual(["chrome", "firefox"]);
    expect(out.value.nextStep.say).toContain("The page lists 2 stores; uncheck one to leave it out.");
    expect(out.hint).toContain("one line per store");
    expect(platform.sent("POST", "/api/cli/stores/submit")).toHaveLength(0);
  });

  it("keeps the single act for a single store", async () => {
    platform.login();
    platform.routes["POST /api/cli/approvals"] = () => minted([]);

    await submit({ browsers: ["chrome"], buildSha: SHA, dryRun: false, api: API });

    expect(platform.sent("POST", "/api/cli/approvals")[0].body.action).toBe("extension_submit");
  });

  it("relays a refusal that names the stores which cannot run, before any approval", async () => {
    platform.login();
    platform.routes["POST /api/cli/approvals"] = () => ({
      status: 409,
      body: {
        code: "STORE_CREDENTIALS_UNREADABLE",
        message: "One store cannot run this version, so no approval was requested. edge: No Edge credentials.",
        refusedBeforeApproval: true,
        stores: [{ store: "edge", act: "upload", code: "STORE_CREDENTIALS_UNREADABLE", message: "No Edge credentials." }],
      },
    });

    const out = JSON.parse(await submit({ browsers: ["chrome", "edge"], buildSha: SHA, dryRun: false, api: API }));

    expect(out.status).toBe("submit-failed");
    expect(out.error.platformCode).toBe("STORE_CREDENTIALS_UNREADABLE");
    expect(out.value.stores.map((row: { store: string }) => row.store)).toEqual(["edge"]);
    expect(out.value.approvalId).toBeUndefined();
  });
});

describe("the call resumed with the version approval runs each store's line", () => {
  const platform = useProjectRoutes("extdev-version-resume-");

  it("reports per store which line ran and which the owner left out, never as missing", async () => {
    platform.login();
    platform.routes[`GET ${READ}`] = () =>
      approved([line("chrome"), line("firefox"), line("edge", "denied")], scopeOf(["chrome", "firefox", "edge"]));

    platform.routes["POST /api/cli/stores/submit"] = () => ({
      body: {
        ok: true,
        projectId: "prj_probe",
        buildId: SHA,
        submissions: [
          { id: "sub_c", store: "chrome", status: "pending" },
          { id: "sub_f", store: "firefox", status: "pending" },
        ],
        approvalId: ID,
        lines: [line("chrome", "spent"), line("firefox", "spent"), line("edge", "denied")],
      },
    });

    const out = JSON.parse(
      await submit({ browsers: ["chrome", "firefox", "edge"], buildSha: SHA, dryRun: false, approvalId: ID, waitSeconds: 0, api: API }),
    );

    expect(out.ok).toBe(true);
    expect(out.status).toBe("submit-dispatched");
    expect(out.value.submittedStores).toEqual(["chrome", "firefox"]);
    expect(out.value.lines.map((row: Line) => [row.store, row.state])).toEqual([
      ["chrome", "spent"],
      ["firefox", "spent"],
      ["edge", "denied"],
    ]);

    expect(out.warnings).toContain("Approval lines: chrome: ran; firefox: ran; edge: left out by the owner.");
    expect(out.warnings.some((row: string) => row.startsWith("NOT submitted: edge."))).toBe(true);
    expect(JSON.stringify(out)).not.toContain("browsers limited to edge");
    expect(platform.sent("POST", "/api/cli/stores/submit")[0].body.approvalId).toBe(ID);
  });

  it("lets a retry name fewer stores than the owner approved", async () => {
    platform.login();
    platform.routes[`GET ${READ}`] = () => approved([line("chrome", "spent"), line("firefox")], scopeOf(["chrome", "firefox"]));
    platform.routes["POST /api/cli/stores/submit"] = () => ({
      body: {
        ok: true,
        submissions: [{ id: "sub_f", store: "firefox", status: "pending" }],
        approvalId: ID,
        lines: [line("firefox", "spent")],
      },
    });

    const out = JSON.parse(await submit({ browsers: ["firefox"], buildSha: SHA, dryRun: false, approvalId: ID, waitSeconds: 0, api: API }));

    expect(out.status).toBe("submit-dispatched");
    expect(platform.sent("POST", "/api/cli/stores/submit")).toHaveLength(1);
  });

  it("refuses a store outside the approval before the platform is asked", async () => {
    platform.login();
    platform.routes[`GET ${READ}`] = () => approved([line("chrome"), line("firefox")], scopeOf(["chrome", "firefox"]));

    const out = JSON.parse(await submit({ browsers: ["chrome", "safari"], buildSha: SHA, dryRun: false, approvalId: ID, api: API }));

    expect(out.status).toBe("approval-rejected");
    expect(out.error.name).toBe("ApprovalScopeMismatch");
    expect(out.error.message).toContain("does not cover safari");
    expect(out.value.outside).toEqual(["safari:upload"]);
    expect(platform.sent("POST", "/api/cli/stores/submit")).toHaveLength(0);
  });

  it("answers consumed when every line asked for already settled", async () => {
    platform.login();
    platform.routes[`GET ${READ}`] = () => approved([line("chrome", "spent"), line("firefox", "denied")], scopeOf(["chrome", "firefox"]));

    const out = JSON.parse(await submit({ browsers: ["chrome", "firefox"], buildSha: SHA, dryRun: false, approvalId: ID, api: API }));

    expect(out.status).toBe("approval-rejected");
    expect(out.error.name).toBe("ApprovalConsumed");
    expect(out.error.message).toContain("chrome: ran; firefox: left out by the owner");
    expect(platform.sent("POST", "/api/cli/stores/submit")).toHaveLength(0);
  });

  it("keeps the approval id when a refused dispatch gave a line back, and names the stores to retry", async () => {
    platform.login();
    platform.routes[`GET ${READ}`] = () => approved([line("chrome"), line("firefox"), line("edge")], scopeOf(["chrome", "firefox", "edge"]));
    platform.routes["POST /api/cli/stores/submit"] = () => ({
      status: 502,
      body: {
        ok: false,
        code: "SUBMIT_DISPATCH_FAILED",
        message: "The platform could not start the firefox store run after 1 other store dispatched.",
        store: "firefox",
        approvalRefunded: true,
        approvalId: ID,
        lines: [line("chrome", "spent"), line("firefox", "refunded"), line("edge", "unspent")],
      },
    });

    const out = JSON.parse(await submit({ browsers: ["chrome", "firefox", "edge"], buildSha: SHA, dryRun: false, approvalId: ID, api: API }));

    expect(out.status).toBe("submit-failed");
    expect(out.value).toMatchObject({ approvalId: ID, approvalRefunded: true });
    expect(out.value.lines.map((row: Line) => row.state)).toEqual(["spent", "refunded", "unspent"]);
    expect(out.hint).toContain(`approvalId ${ID} and browsers limited to firefox, edge`);
    expect(out.hint).toContain("firefox: given back, nothing ran");
  });

  it("answers declined, naming the store, when the owner left out every store asked for", async () => {
    platform.login();
    platform.routes[`GET ${READ}`] = () => approved([line("chrome"), line("edge", "denied")], scopeOf(["chrome", "edge"]));
    platform.routes["POST /api/cli/stores/submit"] = () => ({
      status: 403,
      body: {
        ok: false,
        code: "APPROVAL_LINE_DENIED",
        message: "The owner left edge out of this approval, so nothing ran for it.",
        approvalId: ID,
        lines: [line("edge", "denied")],
      },
    });

    const out = JSON.parse(await submit({ browsers: ["edge"], buildSha: SHA, dryRun: false, approvalId: ID, api: API }));

    expect(out.status).toBe("approval-declined");
    expect(out.error.platformCode).toBe("APPROVAL_LINE_DENIED");
    expect(out.hint).toContain("The owner left edge out on the approval page");
    expect(out.value.lines).toEqual([line("edge", "denied")]);
  });
});

describe("extension_approvals shows the lines of a version approval", () => {
  const platform = useProjectRoutes("extdev-version-status-");

  it("answers each line's state in value.lines and in the hint", async () => {
    platform.login();
    platform.routes[`GET ${READ}`] = () => approved([line("chrome", "spent"), line("firefox"), line("edge", "denied")], scopeOf(["chrome", "firefox", "edge"]));

    const out = JSON.parse(await approvals({ action: "status", approvalId: ID, api: API }));

    expect(out.status).toBe("approved-unused");
    expect(out.value.lines.map((row: Line) => row.state)).toEqual(["spent", "pending", "denied"]);
    expect(out.hint).toContain("Lines: chrome: ran; firefox: not run yet; edge: left out by the owner.");
  });
});
