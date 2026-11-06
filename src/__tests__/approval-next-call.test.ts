// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { evaluateApproval, type ApprovalGateInput } from "../lib/approval-gate";
import { envelope } from "../lib/envelope";
import { answeredAs } from "../lib/submit-action-safety";
import { createToolDispatcher } from "../lib/tool-dispatch";
import * as submitModule from "../tools/submit";
import * as submitCheckModule from "../tools/submit-check";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = `${PROJECT_ROUTE}/stores/chrome/submissions/preflight`;
const APPROVALS = "/api/cli/approvals";
const APPROVAL_ID = "apr_jjs0000000000000000000000000000x";
const DESCRIPTION = "Send build c2b67f5 (version 0.3.0) to chrome, edge, firefox under one approval. Upload sends build c2b67f5 as version 0.3.0.10 to AMO's listed channel for review.";

function answering(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    }) as unknown as Response) as unknown as typeof fetch;
}

function input(over: Partial<ApprovalGateInput>): ApprovalGateInput {
  return {
    command: "extension_submit",
    action: "extension_submit.version",
    scope: { acts: ["chrome:upload", "edge:upload", "firefox:upload"], buildSha: "c2b67f5", version: "0.3.0" },
    description: DESCRIPTION,
    token: "tok_test",
    api: API,
    enabled: true,
    platformAsked: true,
    fetchImpl: answering(201, { approvalId: APPROVAL_ID, approvalUrl: `${API}/device/approve/${APPROVAL_ID}`, description: DESCRIPTION }),
    ...over,
  };
}

function report() {
  return {
    store: "chrome",
    summary: { pass: 1, warn: 0, fail: 0, blockingFailures: 0, canSubmit: true },
    checks: [{ id: "credentials", label: "Store credentials", status: "pass", severity: "blocking", stage: "integration", message: "" }],
    connection: { kind: "oauth", connectedAs: "owner@example.com", healthy: true, itemId: "abcdefghijklmnopabcdefghijklmnop", itemLinked: true },
  };
}

describe("410: an approval names the call that spends it with its tool and the read that tells whether it landed", () => {
  it("renders the next call with the caller's arguments and approvalId, and names extension_approvals status and the waitSeconds wait", async () => {
    const gate = await evaluateApproval(
      input({ nextCall: { tool: "extension_submit", args: { action: "submit", dryRun: false, browsers: ["chrome", "edge", "firefox"], buildSha: "c2b67f5" }, waits: true } }),
    );
    const out = JSON.parse((gate as { envelope: string }).envelope);
    const call = `extension_submit {action: "submit", dryRun: false, browsers: ["chrome","edge","firefox"], buildSha: "c2b67f5", approvalId: "${APPROVAL_ID}"}`;
    const read = `extension_approvals {action: "status", approvalId: "${APPROVAL_ID}"} reads whether a workspace owner has approved it, and that extension_submit call with waitSeconds waits for the approval before it runs.`;

    expect(out.error.message).toContain(`then call ${call}. ${read} Nothing was executed.`);
    expect(out.hint).toBe(`Approve at ${API}/device/approve/${APPROVAL_ID}; then ${call} runs it. ${read}`);
    expect(out.error.message).not.toContain("call this tool again");
    expect(out.hint).not.toContain("re-run with the same arguments");
    expect(out.value.description).toBe(DESCRIPTION);
    expect(out.error.message).toContain(DESCRIPTION);
  });

  it("names the tool whose handler ran when the caller gave no arguments to render", async () => {
    const gate = await evaluateApproval(input({ command: "extension_builds", action: "extension_settings.build", scope: { settingsDigest: "a".repeat(64) } }));
    const out = JSON.parse((gate as { envelope: string }).envelope);

    expect(out.error.message).toContain(`then call extension_builds with the same arguments and approvalId ${APPROVAL_ID}. extension_approvals {action: "status", approvalId: "${APPROVAL_ID}"} reads whether a workspace owner has approved it. Nothing was executed.`);
    expect(out.error.message).not.toContain("waitSeconds");
  });

  it("rewrites the command of an answer the acted-as tool made, and leaves any other answer alone", () => {
    const made = envelope({ ok: false, command: "extension_submit", status: "approval-required" });

    expect(JSON.parse(answeredAs(made, "extension_submit_check", "extension_submit")).command).toBe("extension_submit_check");
    expect(answeredAs(made, "extension_submit_check", "extension_builds")).toBe(made);
    expect(answeredAs("not json", "extension_submit_check", "extension_submit")).toBe("not json");
  });

  describe("through extension_submit_check", () => {
    const platform = useProjectRoutes("extdev-approval-next-call-");

    function serve(): void {
      platform.login();
      platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: report() });
      platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: APPROVAL_ID, approvalUrl: `${API}/device/approve/${APPROVAL_ID}`, description: DESCRIPTION } });
    }

    it("answers with the check tool as its command and names extension_submit as the call that spends the approval", async () => {
      if (process.platform === "win32") return;

      serve();

      const out = JSON.parse(await submitCheckModule.handler({ action: "submit", browsers: ["chrome"], buildSha: "c2b67f5", dryRun: false, api: API }));

      expect(out.status).toBe("approval-required");
      expect(out.command).toBe("extension_submit_check");
      expect(out.error.message).toContain(`then call extension_submit {action: "submit", dryRun: false, browsers: ["chrome"], buildSha: "c2b67f5", approvalId: "${APPROVAL_ID}"}`);
      expect(out.error.message).toContain(`extension_approvals {action: "status", approvalId: "${APPROVAL_ID}"} reads whether a workspace owner has approved it`);
      expect(out.error.message).not.toContain("this tool");
    });

    it("the dispatcher's alias path names the check tool too", async () => {
      if (process.platform === "win32") return;

      serve();

      const dispatch = createToolDispatcher({ tools: [submitModule, submitCheckModule], options: { features: ["local", "platform"], noShip: false } });
      const frame = await dispatch({ name: "extension_submit_check", arguments: { action: "submit", browsers: ["chrome"], buildSha: "c2b67f5", dryRun: false, api: API } });
      const out = JSON.parse(frame.content[0]?.text ?? "{}");

      expect(out.status).toBe("approval-required");
      expect(out.command).toBe("extension_submit_check");
      expect(out.hint).toContain(`extension_submit {action: "submit", dryRun: false, browsers: ["chrome"], buildSha: "c2b67f5", approvalId: "${APPROVAL_ID}"} runs it.`);
    });
  });
});
