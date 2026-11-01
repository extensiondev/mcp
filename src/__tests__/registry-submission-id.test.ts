import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { readStores } from "../tools/store-status";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes, type Reply } from "./fixtures/project-routes";

const SUB = "sub-20261101025425";
const REGISTRY_FILES = "/api/local-registry/acme/widget/_extension-dev/stores";
const APPROVALS = "/api/cli/approvals";

const registryRow = {
  id: SUB,
  store: "firefox",
  channel: "unlisted",
  storeSubmissionId: "6655001",
  version: "0.3.0.9",
  status: "approved",
  rawStatus: "approved",
  submittedAt: "2026-11-01T02:54:25.000Z",
  buildId: "a1b2c3d",
  storeUrl: "https://addons.mozilla.org/firefox/addon/rebeccat",
};

const olderPlatformRecord = {
  id: "def49314",
  store: "firefox",
  channel: "unlisted",
  version: "0.2.0.7",
  buildId: "9f8e7d6",
  status: "approved",
  submittedAt: "2026-10-27T22:22:52.000Z",
  run: null,
};

function registryOnly(platform: ReturnType<typeof useProjectRoutes>, rows: Array<Record<string, unknown>>): void {
  platform.routes[`GET ${REGISTRY_FILES}/submissions.json`] = () => ({
    body: { projectId: "acme--widget", updatedAt: "2026-11-01T02:54:25.000Z", submissions: rows },
  });
}

function firefoxRow(out: { value: { stores: Array<Record<string, unknown>> } }): Record<string, any> {
  return out.value.stores.find((row) => row.store === "firefox") ?? {};
}

describe("a registry-only submission keeps its sub- id in every read", () => {
  const platform = useProjectRoutes("extdev-registry-id-");

  it("answers the registry record's id as lastSubmission.id when no login reads the platform", async () => {
    if (process.platform === "win32") return;

    registryOnly(platform, [registryRow]);

    const out = JSON.parse(await readStores({ workspace: "acme", project: "widget", api: API }));

    expect(out.ok).toBe(true);
    expect(firefoxRow(out).lastSubmission).toMatchObject({ id: SUB, version: "0.3.0.9", status: "approved" });
  });

  it("keeps the id when the registry names it submissionId", async () => {
    if (process.platform === "win32") return;

    const { id: _id, ...rest } = registryRow;
    registryOnly(platform, [{ ...rest, submissionId: SUB }]);

    const out = JSON.parse(await readStores({ workspace: "acme", project: "widget", api: API }));

    expect(firefoxRow(out).lastSubmission.id).toBe(SUB);
  });

  it("answers the registry record over an older platform record, and extension_submit status names its id", async () => {
    if (process.platform === "win32") return;

    platform.login();
    registryOnly(platform, [registryRow]);
    platform.routes["GET /api/cli/stores/submissions"] = () => ({ body: { submissions: [olderPlatformRecord] } });
    platform.routes[`GET ${PROJECT_ROUTE}/stores/firefox/submissions`] = () => ({ body: [registryRow, olderPlatformRecord] });

    const row = firefoxRow(JSON.parse(await readStores({ project: "acme/widget", api: API })));

    expect(row.lastSubmission).toMatchObject({ id: SUB, version: "0.3.0.9" });
    expect((row.submissionHistory ?? []).map((entry: { id?: string }) => entry.id)).toEqual(["def49314"]);

    const status = JSON.parse(await submit({ action: "status", browsers: ["firefox"], project: "acme/widget", api: API }));

    expect(status.status).toBe("status-read");
    expect(status.value.stores[0]).toMatchObject({ store: "firefox", submissionId: SUB, version: "0.3.0.9" });
  });
});

function approvalFor(action: string, scope: Record<string, string>): () => Reply {
  return () => ({
    status: 403,
    body: { code: "APPROVAL_REQUIRED", message: "Needs an owner's approval.", approvalRequest: { action, scope, fingerprint: actionFingerprint(action, scope) } },
  });
}

describe("acts that take a submissionId send a sub- id the same way", () => {
  const platform = useProjectRoutes("extdev-registry-id-acts-");

  it.each([
    { action: "publish", store: "chrome", route: `POST ${PROJECT_ROUTE}/stores/chrome/publish`, body: { submissionId: SUB } },
    { action: "release", store: "safari", route: `POST ${PROJECT_ROUTE}/stores/safari/release`, body: { submissionId: SUB } },
    { action: "cancel", store: "firefox", route: `POST ${PROJECT_ROUTE}/stores/firefox/submissions/${SUB}/cancel`, body: undefined },
  ])("$action carries $store submission $route", async ({ action, store, route, body }) => {
    if (process.platform === "win32") return;

    const scope = { store, submissionId: SUB };
    platform.login();
    platform.routes[route] = approvalFor(`extension_store.${action}`, scope);
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: { approvalId: "apr_sub", approvalUrl: `${API}/approve/apr_sub`, expiresAt: "2026-11-01T18:00:00.000Z" },
    });

    const out = JSON.parse(await submit({ action, ...(action === "cancel" ? { store } : { browsers: [store] }), submissionId: SUB, api: API }));
    const [method, pathname] = route.split(" ");
    const sent = platform.sent(method!, pathname!);

    expect(sent).toHaveLength(1);
    if (body) expect(sent[0]!.body).toEqual(body);

    expect(platform.sent("POST", APPROVALS)[0]!.body).toMatchObject({ action: `extension_store.${action}`, scope });
    expect(out.status).toBe("approval-required");
    expect(out.value.approvalUrl).toBe(`${API}/approve/apr_sub`);
  });
});
