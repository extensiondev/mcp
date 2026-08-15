import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { actionFingerprint, evaluateApproval } from "../lib/approval-gate";
import { handler as submitHandler } from "../tools/submit";
import { handler as promoteHandler } from "../tools/release-promote";
import { handler as sharesHandler } from "../tools/shares";

type Call = { key: string; url: string; method: string; body: unknown };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function router(
  calls: Call[],
  routes: Record<string, (call: Call) => Response>,
): typeof fetch {
  return (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = String(init?.method || "GET").toUpperCase();
    const pathname = new URL(url).pathname;
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: Call = { key: `${method} ${pathname}`, url, method, body };
    calls.push(call);
    for (const [prefix, respond] of Object.entries(routes)) {
      const [rmethod, rpath] = prefix.split(" ");
      if (method === rmethod && pathname.startsWith(rpath)) return respond(call);
    }
    throw new Error(`unrouted ${call.key}`);
  }) as unknown as typeof fetch;
}

const GEN_ID = `gen_${"a".repeat(64)}`;

describe("the approval gate guards irreversible outward actions and cannot self-approve", () => {
  let prevToken: string | undefined;
  let prevGate: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;
  let calls: Call[];

  beforeEach(() => {
    prevToken = process.env.EXTENSION_DEV_TOKEN;
    prevGate = process.env.EXTENSION_DEV_APPROVAL_GATE;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    prevFetch = global.fetch;
    process.env.EXTENSION_DEV_TOKEN = "tok_test";
    process.env.EXTENSION_DEV_API_URL = "https://www.extension.dev";
    calls = [];
  });

  afterEach(() => {
    if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = prevToken;
    if (prevGate === undefined) delete process.env.EXTENSION_DEV_APPROVAL_GATE;
    else process.env.EXTENSION_DEV_APPROVAL_GATE = prevGate;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;
    global.fetch = prevFetch;
  });

  const hit = (key: string): boolean => calls.some((c) => c.key === key);

  describe("fingerprint binding", () => {
    it("is deterministic and independent of argument order", () => {
      const a = actionFingerprint("extension_submit", {
        browsers: ["edge", "chrome"],
        buildSha: "abc123",
        channel: "stable",
      });
      const b = actionFingerprint("extension_submit", {
        channel: "stable",
        buildSha: "abc123",
        browsers: ["chrome", "edge"],
      });
      expect(a).toBe(b);
    });

    it("changes with the action, so a submit grant and a promote grant never share a fingerprint", () => {
      const submit = actionFingerprint("extension_submit", {
        buildSha: "abc123",
        channel: "stable",
      });
      const promote = actionFingerprint("extension_release_promote", {
        buildId: "abc123",
        channel: "stable",
      });
      expect(submit).not.toBe(promote);
    });

    it("changes with the arguments, so one build's grant cannot cover another", () => {
      const one = actionFingerprint("extension_submit", { buildSha: "aaa" });
      const two = actionFingerprint("extension_submit", { buildSha: "bbb" });
      expect(one).not.toBe(two);
    });
  });

  describe("gate disabled by default", () => {
    it("lets a real submission through with no approval, frictionless", async () => {
      global.fetch = router(calls, {
        "POST /api/cli/stores/submit": () => jsonResponse({ ok: true }),
      });
      const out = JSON.parse(
        await submitHandler({
          browsers: ["chrome"],
          buildSha: "abc1234",
          dryRun: false,
        }),
      );
      expect(hit("POST /api/cli/approvals")).toBe(false);
      expect(hit("POST /api/cli/stores/submit")).toBe(true);
      expect(out.status).toBe("submitted");
    });
  });

  describe("gate enabled", () => {
    beforeEach(() => {
      process.env.EXTENSION_DEV_APPROVAL_GATE = "1";
    });

    it("does not run a real submission without an approval, and returns an approval request", async () => {
      global.fetch = router(calls, {
        "POST /api/cli/approvals": () =>
          jsonResponse({
            approvalId: "apr_new",
            approvalUrl: "https://www.extension.dev/approve/apr_new",
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          }),
        "POST /api/cli/stores/submit": () => jsonResponse({ ok: true }),
      });
      const out = JSON.parse(
        await submitHandler({
          browsers: ["chrome"],
          buildSha: "abc1234",
          dryRun: false,
        }),
      );
      expect(out.ok).toBe(false);
      expect(out.status).toBe("approval-required");
      expect(out.error.code).toBe("E_APPROVAL_REQUIRED");
      expect(out.value.approvalId).toBe("apr_new");
      expect(hit("POST /api/cli/approvals")).toBe(true);
      expect(hit("POST /api/cli/stores/submit")).toBe(false);
    });

    it("leaves a dry-run preflight ungated", async () => {
      global.fetch = router(calls, {
        "POST /api/cli/stores/submit": () => jsonResponse({ ok: true }),
      });
      await submitHandler({
        browsers: ["chrome"],
        buildSha: "abc1234",
        dryRun: true,
      });
      expect(hit("POST /api/cli/approvals")).toBe(false);
      expect(hit("POST /api/cli/stores/submit")).toBe(true);
    });

    it("leaves a read-only share listing ungated", async () => {
      global.fetch = router(calls, {
        "GET /api/artifacts": () => jsonResponse({ artifacts: [], count: 0 }),
      });
      const out = JSON.parse(await sharesHandler({ action: "list" }));
      expect(hit("POST /api/cli/approvals")).toBe(false);
      expect(out.ok).toBe(true);
    });

    it("rejects a wrong-scope approval and does not submit", async () => {
      global.fetch = router(calls, {
        "GET /api/cli/approvals": () =>
          jsonResponse({ status: "approved", fingerprint: "deadbeef" }),
        "POST /api/cli/stores/submit": () => jsonResponse({ ok: true }),
      });
      const out = JSON.parse(
        await submitHandler({
          browsers: ["chrome"],
          buildSha: "abc1234",
          dryRun: false,
          approvalId: "apr_wrong",
        }),
      );
      expect(out.ok).toBe(false);
      expect(out.status).toBe("approval-rejected");
      expect(out.error.name).toBe("ApprovalScopeMismatch");
      expect(hit("POST /api/cli/stores/submit")).toBe(false);
    });

    it("refuses a pending approval and does not submit", async () => {
      global.fetch = router(calls, {
        "GET /api/cli/approvals": () => jsonResponse({ status: "pending" }),
        "POST /api/cli/stores/submit": () => jsonResponse({ ok: true }),
      });
      const out = JSON.parse(
        await submitHandler({
          browsers: ["chrome"],
          buildSha: "abc1234",
          dryRun: false,
          approvalId: "apr_pending",
        }),
      );
      expect(out.status).toBe("approval-pending");
      expect(hit("POST /api/cli/stores/submit")).toBe(false);
    });

    it("fails closed when the verify endpoint is absent, and does not submit", async () => {
      global.fetch = router(calls, {
        "GET /api/cli/approvals": () =>
          jsonResponse({ message: "not found" }, 404),
        "POST /api/cli/stores/submit": () => jsonResponse({ ok: true }),
      });
      const out = JSON.parse(
        await submitHandler({
          browsers: ["chrome"],
          buildSha: "abc1234",
          dryRun: false,
          approvalId: "apr_absent",
        }),
      );
      expect(out.ok).toBe(false);
      expect(out.status).toBe("approval-rejected");
      expect(hit("POST /api/cli/stores/submit")).toBe(false);
    });

    it("submits when a matching approval is granted, carrying the id to the server", async () => {
      const fingerprint = actionFingerprint("extension_submit", {
        browsers: ["chrome"],
        buildSha: "abc1234",
        channel: "stable",
      });
      global.fetch = router(calls, {
        "GET /api/cli/approvals": () =>
          jsonResponse({ status: "approved", fingerprint, used: false }),
        "POST /api/cli/stores/submit": () => jsonResponse({ ok: true }),
      });
      const out = JSON.parse(
        await submitHandler({
          browsers: ["chrome"],
          buildSha: "abc1234",
          dryRun: false,
          approvalId: "apr_ok",
        }),
      );
      expect(
        calls.some((c) => c.key.startsWith("GET /api/cli/approvals/")),
      ).toBe(true);
      expect(out.status).toBe("submitted");
      const submitCall = calls.find(
        (c) => c.key === "POST /api/cli/stores/submit",
      );
      expect((submitCall?.body as { approvalId?: string })?.approvalId).toBe(
        "apr_ok",
      );
    });

    it("does not promote without an approval", async () => {
      global.fetch = router(calls, {
        "POST /api/cli/approvals": () =>
          jsonResponse({
            approvalId: "apr_promo",
            approvalUrl: "https://www.extension.dev/approve/apr_promo",
          }),
        "POST /api/cli/release/promote": () => jsonResponse({ ok: true }),
      });
      const out = JSON.parse(
        await promoteHandler({ buildId: "abc1234", channel: "stable" }),
      );
      expect(out.status).toBe("approval-required");
      expect(hit("POST /api/cli/release/promote")).toBe(false);
    });

    it("refuses to promote with a submit-scoped grant, proving cross-action binding", async () => {
      const submitFingerprint = actionFingerprint("extension_submit", {
        browsers: ["chrome"],
        buildSha: "abc1234",
        channel: "stable",
      });
      global.fetch = router(calls, {
        "GET /api/cli/approvals": () =>
          jsonResponse({ status: "approved", fingerprint: submitFingerprint }),
        "POST /api/cli/release/promote": () => jsonResponse({ ok: true }),
      });
      const out = JSON.parse(
        await promoteHandler({
          buildId: "abc1234",
          channel: "stable",
          approvalId: "apr_submit_grant",
        }),
      );
      expect(out.status).toBe("approval-rejected");
      expect(out.error.name).toBe("ApprovalScopeMismatch");
      expect(hit("POST /api/cli/release/promote")).toBe(false);
    });

    it("promotes when a matching approval is granted", async () => {
      const fingerprint = actionFingerprint("extension_release_promote", {
        buildId: "abc1234",
        channel: "stable",
      });
      global.fetch = router(calls, {
        "GET /api/cli/approvals": () =>
          jsonResponse({ status: "approved", fingerprint }),
        "POST /api/cli/release/promote": () => jsonResponse({ ok: true }),
      });
      const out = JSON.parse(
        await promoteHandler({
          buildId: "abc1234",
          channel: "stable",
          approvalId: "apr_ok",
        }),
      );
      expect(out.status).toBe("promoted");
      expect(hit("POST /api/cli/release/promote")).toBe(true);
    });

    it("does not revoke a share without an approval", async () => {
      global.fetch = router(calls, {
        "POST /api/cli/approvals": () =>
          jsonResponse({
            approvalId: "apr_rev",
            approvalUrl: "https://www.extension.dev/approve/apr_rev",
          }),
        "DELETE /api/artifacts": () => jsonResponse({ revoked: true }),
      });
      const out = JSON.parse(
        await sharesHandler({ action: "revoke", artifactId: GEN_ID }),
      );
      expect(out.status).toBe("approval-required");
      expect(hit(`DELETE /api/artifacts/${GEN_ID}`)).toBe(false);
    });

    it("revokes a share when a matching approval is granted", async () => {
      const fingerprint = actionFingerprint("extension_shares.revoke", {
        artifactId: GEN_ID,
      });
      global.fetch = router(calls, {
        "GET /api/cli/approvals": () =>
          jsonResponse({ status: "approved", fingerprint }),
        "DELETE /api/artifacts": () => jsonResponse({ revoked: true }),
      });
      const out = JSON.parse(
        await sharesHandler({
          action: "revoke",
          artifactId: GEN_ID,
          approvalId: "apr_ok",
        }),
      );
      expect(out.status).toBe("revoked");
      expect(hit(`DELETE /api/artifacts/${GEN_ID}`)).toBe(true);
    });
  });

  describe("the local gate cannot mint its own approval", () => {
    it("returns not-required only when the operator flag is off", async () => {
      const offResult = await evaluateApproval({
        command: "extension_submit",
        action: "extension_submit",
        scope: { buildSha: "abc" },
        description: "x",
        token: "tok",
        enabled: false,
      });
      expect(offResult.blocked).toBe(false);
    });

    it("with no approval id it must reach the server and never approves locally", async () => {
      global.fetch = router(calls, {
        "POST /api/cli/approvals": () =>
          jsonResponse({ approvalId: "apr_x", approvalUrl: "https://www.extension.dev/a" }),
      });
      const result = await evaluateApproval({
        command: "extension_submit",
        action: "extension_submit",
        scope: { buildSha: "abc" },
        description: "x",
        token: "tok",
        enabled: true,
      });
      expect(result.blocked).toBe(true);
      expect(hit("POST /api/cli/approvals")).toBe(true);
    });
  });
});
