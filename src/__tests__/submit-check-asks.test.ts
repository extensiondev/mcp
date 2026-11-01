// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators


import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { runAskingOnly } from "../lib/ask-only";
import { projectApiSend, type ProjectApi } from "../lib/project-api";
import { SUBMIT_CHECK_ACTIONS, SUBMIT_READ_ACTIONS, SUBMIT_SETTING_ACTIONS, SUBMIT_SHIP_ACTIONS } from "../lib/submit-action-safety";
import { schema as checkSchema } from "../tools/submit-check";
import { SUBMIT_ACTIONS, schema as submitSchema } from "../tools/submit";
import { usePlatformWorld, WORLD_API, WORLD_PROJECT_ID } from "./fixtures/platform-world";

const world = usePlatformWorld("extdev-submit-check-asks-");
const api = { api: WORLD_API };
const P = `/api/projects/${WORLD_PROJECT_ID}`;
const executed: string[] = [];
const roots: string[] = [];

afterEach(() => {
  executed.length = 0;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function actRoute(route: string, action: string, scope: (body: any) => Record<string, string>) {
  world.routes.push([
    new RegExp(`^POST ${P}/${route}$`),
    (call) => {
      if (call.body?.approvalId) {
        executed.push(`${call.method} ${call.path}`);

        return { body: { ok: true, dispatched: true, dispatchId: "d-1", dispatchedAt: "2026-11-01T10:00:00.000Z" } };
      }

      const asked = scope(call.body ?? {});

      return { status: 403, body: { code: "APPROVAL_REQUIRED", message: "needs approval", approvalRequest: { action, scope: asked, fingerprint: actionFingerprint(action, asked) } } };
    },
  ]);
}

function writeRoutes() {
  world.routes.push([
    /^(PUT|PATCH) /,
    (call) => {
      executed.push(`${call.method} ${call.path}`);

      return { body: { ok: true, changes: ["written"] } };
    },
  ]);
}

const sent = () => world.calls.map((call) => `${call.method} ${call.path}`);

function expectAskedOnly(out: any, label: string) {
  expect(out.status, label).toBe("approval-required");
  expect(JSON.stringify(out.value), label).toContain("/device/approve/apr_world");
  expect(sent(), label).toContain("POST /api/cli/approvals");
  expect(executed, label).toEqual([]);
  expect(world.calls.filter((call) => call.body?.approvalId), label).toEqual([]);
  expect(sent().filter((call) => /^(PUT|PATCH) /.test(call)), label).toEqual([]);
}

function storeMdProject(summary: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-check-listing-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "STORE.md"), `# Store metadata\n\n## Listing\n\n- Name: PII Shield\n- Summary: ${summary}\n- Description: Blurs names on every open tab.\n`);

  return root;
}

describe("extension_submit_check asks for the approval of every store act and executes none (ledger 373)", () => {
  it("takes every action of extension_submit, derived from the safety lists, and every input but approvalId", () => {
    expect([...SUBMIT_CHECK_ACTIONS].sort()).toEqual([...SUBMIT_READ_ACTIONS, "submit", ...SUBMIT_SHIP_ACTIONS, ...SUBMIT_SETTING_ACTIONS].sort());
    expect([...SUBMIT_CHECK_ACTIONS].sort()).toEqual([...SUBMIT_ACTIONS].sort());
    expect(checkSchema.inputSchema.properties.action.enum).toEqual([...SUBMIT_CHECK_ACTIONS]);

    const inputs = Object.keys(submitSchema.inputSchema.properties).filter((key) => key !== "approvalId").sort();

    expect(Object.keys(checkSchema.inputSchema.properties).sort()).toEqual(inputs);
  });

  const acts: Array<{ label: string; route: string; action: string; args: Record<string, unknown>; scope: (body: any) => Record<string, string> }> = [
    { label: "chrome cancel", route: "stores/chrome/submissions/sub_1/cancel", action: "extension_store.cancel", args: { action: "cancel", store: "chrome", submissionId: "sub_1" }, scope: () => ({ store: "chrome", submissionId: "sub_1" }) },
    { label: "safari cancel", route: "stores/safari/submissions/b40be3ae/cancel", action: "extension_store.cancel", args: { action: "cancel", store: "safari", submissionId: "b40be3ae", waitSeconds: 0 }, scope: () => ({ store: "safari", submissionId: "b40be3ae" }) },
    { label: "chrome publish", route: "stores/chrome/publish", action: "extension_store.publish", args: { action: "publish", browsers: ["chrome"] }, scope: () => ({ store: "chrome", submissionId: "sub_2" }) },
    { label: "safari review", route: "stores/safari/publish", action: "extension_store.publish", args: { action: "review", browsers: ["safari"] }, scope: () => ({ store: "safari", submissionId: "sub_3" }) },
    { label: "chrome rollout", route: "stores/chrome/rollout", action: "extension_store.rollout", args: { action: "rollout", store: "chrome", deployPercentage: 50 }, scope: (body) => ({ store: "chrome", deployPercentage: String(body.deployPercentage) }) },
    { label: "safari release", route: "stores/safari/release", action: "extension_store.release", args: { action: "release", browsers: ["safari"] }, scope: () => ({ store: "safari", submissionId: "sub_4" }) },
  ];

  for (const act of acts) {
    it(`answers the ${act.label} approval request and never reaches the act with an approval`, async () => {
      world.login();
      actRoute(act.route, act.action, act.scope);
      writeRoutes();
      const out = await world.call("extension_submit_check", { ...act.args, ...api });

      expectAskedOnly(out, act.label);
      expect(world.calls.find((call) => call.path === "/api/cli/approvals")?.body?.action).toBe(act.action);
    });
  }

  it("answers a publish of several stores as one version approval and sends no draft", async () => {
    world.login();
    actRoute("stores/chrome/publish", "extension_store.publish", () => ({ store: "chrome", submissionId: "sub_2" }));
    writeRoutes();
    const out = await world.call("extension_submit_check", { action: "publish", browsers: ["chrome", "edge"], buildSha: "603fc8a", ...api });

    expectAskedOnly(out, "chrome and edge publish");
    expect(sent().filter((call) => call.endsWith("/publish"))).toEqual([]);
  });

  it("asks for a public submission mode without writing the store settings", async () => {
    world.login();
    writeRoutes();
    const out = await world.call("extension_submit_check", { action: "configure-store", store: "edge", storeSettings: { submissionMode: "review" }, ...api });

    expectAskedOnly(out, "edge review mode");
    expect(world.calls.find((call) => call.path === "/api/cli/approvals")?.body).toMatchObject({ action: "extension_settings.store", storeSettings: { edge: { dryRun: false, publishAfter: true } } });
  });

  it("asks for a listing the platform derives a value of without writing it", async () => {
    world.login();
    writeRoutes();
    const projectPath = storeMdProject("Blur personal data on a page");
    const out = await world.call("extension_submit_check", { action: "sync-listing", browsers: ["safari"], projectPath, ...api });

    expect(JSON.stringify(out)).toContain("approval-required");
    expect(executed).toEqual([]);
    expect(sent()).toContain("POST /api/cli/approvals");
    expect(sent().filter((call) => /^(PUT|PATCH) /.test(call))).toEqual([]);
  });

  it("refuses a plain listing sync, which writes at once, and writes nothing", async () => {
    world.login();
    writeRoutes();
    const projectPath = storeMdProject("Blur names, emails, phone numbers and card numbers on every open tab with one click, before you share it all.");
    const out = await world.call("extension_submit_check", { action: "sync-listing", browsers: ["safari"], projectPath, ...api });

    expect(out.status).toBe("check-refused");
    expect(out.value.useTool).toBe("extension_submit");
    expect(executed).toEqual([]);
    expect(sent()).not.toContain("POST /api/cli/approvals");
  });

  it("refuses every act carrying an approvalId, a plain setting and any ask with the gate off, before anything is sent", async () => {
    world.login();
    writeRoutes();
    const refusedCalls = [
      { action: "cancel", store: "safari", submissionId: "b40be3ae", approvalId: "apr_world" },
      { action: "publish", browsers: ["chrome"], approvalId: "apr_world" },
      { action: "rollout", store: "chrome", deployPercentage: 50, approvalId: "apr_world" },
      { action: "release", browsers: ["safari"], approvalId: "apr_world" },
      { action: "sync-listing", browsers: ["safari"], projectPath: "/tmp/x", approvalId: "apr_world" },
      { action: "configure-store", store: "edge", storeSettings: { submissionMode: "review" }, approvalId: "apr_world" },
      { action: "configure-store", store: "chrome", storeSettings: { enabled: true } },
    ];

    for (const args of refusedCalls) {
      const out = await world.call("extension_submit_check", { ...args, ...api });

      expect(out.status, JSON.stringify(args)).toBe("check-refused");
      expect(out.value.useTool).toBe("extension_submit");
    }

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";

    for (const args of [{ action: "cancel", store: "chrome", submissionId: "sub_1" }, { action: "configure-store", store: "edge", storeSettings: { submissionMode: "review" } }]) {
      const out = await world.call("extension_submit_check", { ...args, ...api });

      expect(out.status, JSON.stringify(args)).toBe("check-refused");
      expect(out.error.message).toContain("EXTENSION_DEV_APPROVAL_GATE");
    }

    expect(sent()).toEqual([]);
  });

  it("extension_submit still writes a plain setting at once", async () => {
    world.login();
    writeRoutes();
    const out = await world.call("extension_submit", { action: "configure-store", store: "chrome", storeSettings: { enabled: true }, ...api });

    expect(out.status).toBe("store-configured");
    expect(executed).toEqual([`PUT ${P}/stores/config`]);
  });

  it("never sends a write or an approvalId during a check call, even from a path that did not ask first", async () => {
    world.login();
    writeRoutes();
    const projectApi = { base: WORLD_API, token: "claims.sig", command: "extension_submit", projectId: WORLD_PROJECT_ID, ref: { workspace: "acme", project: "widget" } } as unknown as ProjectApi;
    const put = await runAskingOnly(() => projectApiSend(projectApi, "PUT", "stores/config", { chrome: { enabled: true } }));
    const spend = await runAskingOnly(() => projectApiSend(projectApi, "POST", "stores/chrome/publish", { approvalId: "apr_world" }));
    const ask = await runAskingOnly(() => projectApiSend(projectApi, "POST", "stores/chrome/submissions/preflight", {}));

    expect(put).toMatchObject({ ok: false, code: "ASK_ONLY" });
    expect(spend).toMatchObject({ ok: false, code: "ASK_ONLY" });
    expect(ask.ok).toBe(true);
    expect(sent()).toEqual([`POST ${P}/stores/chrome/submissions/preflight`]);
  });
});
