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
import { SUBMIT_CHECK_ACTIONS, SUBMIT_CONNECT_ACTIONS, SUBMIT_READ_ACTIONS, SUBMIT_SETTING_ACTIONS, SUBMIT_SHIP_ACTIONS } from "../lib/submit-action-safety";
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
    expect([...SUBMIT_CHECK_ACTIONS].sort()).toEqual([...SUBMIT_READ_ACTIONS, "submit", ...SUBMIT_SHIP_ACTIONS, ...SUBMIT_SETTING_ACTIONS, ...SUBMIT_CONNECT_ACTIONS].sort());
    expect([...SUBMIT_CHECK_ACTIONS].sort()).toEqual([...SUBMIT_ACTIONS].sort());
    expect(checkSchema.inputSchema.properties.action.enum).toEqual([...SUBMIT_CHECK_ACTIONS]);

    const inputs = Object.keys(submitSchema.inputSchema.properties).filter((key) => key !== "approvalId").sort();

    expect(Object.keys(checkSchema.inputSchema.properties).sort()).toEqual(inputs);
  });



  it("refuses every act carrying an approvalId and a plain setting, before anything is sent", async () => {
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

    expect(sent()).toEqual([]);
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
