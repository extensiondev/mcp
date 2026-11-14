import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { actionFingerprint, evaluateApproval, requestApprovalAfterRefusal } from "../lib/approval-gate";
import { handler as promoteHandler, schema as promoteSchema } from "../tools/release-promote";
import { handler as sharesHandler } from "../tools/shares";
import { approvalRecord, promoteAnswer, submitAnswer } from "./fixtures/platform-answers";

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
    let body: unknown;

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

const WRONG_ENV =
  "This build was produced for Preview, but the Stable channel takes Stable builds. Rebuild this commit for Stable (Builds, Rebuild), then release it. The rebuild spends 1 build from the monthly allowance.";

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

describe("the approval gate believes only a complete record", () => {
  const scope = { buildId: "abc1234", channel: "stable" };
  const action = "extension_release_promote";
  const future = new Date(Date.now() + 60_000).toISOString();

  async function verify(record: Record<string, unknown>) {
    return evaluateApproval({
      command: "extension_release_promote",
      action,
      scope,
      description: "Promote.",
      approvalId: "apr_1",
      token: "tok",
      enabled: true,
      fetchImpl: (async () => jsonResponse(record)) as unknown as typeof fetch,
    });
  }

  it("refuses an approved record with no fingerprint", async () => {
    const gate = await verify({ status: "approved", expiresAt: future, used: false });
    expect(gate.blocked).toBe(true);
    expect(JSON.parse((gate as { envelope: string }).envelope).error.name).toBe("ApprovalUnverifiable");
  });

  it("refuses an approved record with no readable expiry or no used flag", async () => {
    const fingerprint = actionFingerprint(action, scope);
    const noExpiry = await verify({ status: "approved", fingerprint, used: false });
    expect(noExpiry.blocked).toBe(true);
    const noUsed = await verify({ status: "approved", fingerprint, expiresAt: future });
    expect(noUsed.blocked).toBe(true);
  });

  it("accepts a complete record, with a numeric expiry too", async () => {
    const fingerprint = actionFingerprint(action, scope);
    const iso = await verify({ status: "approved", fingerprint, expiresAt: future, used: false });
    expect(iso.blocked).toBe(false);
    const ms = await verify({ status: "approved", fingerprint, expiresAt: Date.now() + 60_000, used: false });
    expect(ms.blocked).toBe(false);
  });

  it("says a spent approval may already have run the action, and to read its state first", async () => {
    const fingerprint = actionFingerprint(action, scope);
    const gate = await verify({ status: "approved", fingerprint, expiresAt: future, used: true });
    expect(gate.blocked).toBe(true);
    const envelope = JSON.parse((gate as { envelope: string }).envelope);
    expect(envelope.error.name).toBe("ApprovalConsumed");
    expect(envelope.error.message).not.toMatch(/so nothing was executed/);
    expect(envelope.error.message).toMatch(/This call executed nothing/);
    expect(envelope.error.message).toMatch(/may already have run/);
  });

  it("does not tell the agent to wait for an approval the platform never created", async () => {
    const gate = await evaluateApproval({
      command: "extension_release_promote",
      action,
      scope,
      description: "Promote.",
      token: "tok",
      enabled: true,
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    expect(gate.blocked).toBe(true);
    const envelope = JSON.parse((gate as { envelope: string }).envelope);
    expect(envelope.error.name).toBe("ApprovalRequestUnconfirmed");
    expect(envelope.error.message).not.toContain("<from the response>");
  });
});

describe("478: a standing approval of the same act is reused before a fresh one is minted", () => {
  const API_BASE = "https://www.extension.dev";
  const token = `${Buffer.from(JSON.stringify({ u: "acme", p: "widget" })).toString("base64url")}.sig`;
  const scope = { browsers: ["chrome"], buildSha: "93ea0f1" };
  const fingerprint = actionFingerprint("extension_submit", scope);
  let isolated = "";
  let previousXdg: string | undefined;
  let previousFetch: typeof fetch;
  let calls: Call[];
  let minted: string[];
  let read: Record<string, unknown>;

  beforeEach(() => {
    isolated = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-standing-approval-"));
    previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = isolated;
    previousFetch = global.fetch;
    calls = [];
    minted = [];
    read = { status: "pending" };
    global.fetch = router(calls, {
      "POST /api/cli/approvals": () => {
        const approvalId = `apr_standing_${minted.length + 1}`;
        minted.push(approvalId);

        return jsonResponse({ approvalId, approvalUrl: `${API_BASE}/device/approve/${approvalId}`, expiresAt: new Date(Date.now() + 600_000).toISOString() });
      },
      "GET /api/cli/approvals/": () => jsonResponse({ fingerprint, used: false, expiresAt: new Date(Date.now() + 600_000).toISOString(), ...read }),
    });
  });

  afterEach(() => {
    global.fetch = previousFetch;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;

    fs.rmSync(isolated, { recursive: true, force: true });
  });

  const ask = () =>
    evaluateApproval({
      command: "extension_submit",
      action: "extension_submit",
      scope,
      description: "Submit build 93ea0f1 to chrome for store review.",
      token,
      api: API_BASE,
      enabled: true,
      fetchImpl: global.fetch,
    });
  const mints = () => calls.filter((call) => call.key === "POST /api/cli/approvals").length;

  it("answers the approval it minted earlier while the owner has not decided, names the call with its id and mints nothing", async () => {
    const first = JSON.parse((await ask() as { envelope: string }).envelope);
    const again = JSON.parse((await ask() as { envelope: string }).envelope);

    expect(first.status).toBe("approval-required");
    expect(first.value.approvalId).toBe("apr_standing_1");
    expect(again.status).toBe("approval-pending");
    expect(again.value.approvalId).toBe("apr_standing_1");
    expect(again.hint).toContain("call again with the same arguments and approvalId apr_standing_1");
    expect(again.value.replaces).toBeUndefined();
    expect(mints()).toBe(1);
  });

  it("runs the act under the approval the owner already granted instead of replacing it", async () => {
    await ask();
    read = { status: "approved" };

    expect(await ask()).toEqual({ blocked: false, approvalId: "apr_standing_1" });
    expect(mints()).toBe(1);
  });

  it("names the granted approval, not a bare refusal, when the platform's own refusal re-asks for one", async () => {
    await ask();
    read = { status: "approved" };

    const out = JSON.parse(
      await requestApprovalAfterRefusal({
        command: "extension_submit",
        action: "extension_submit",
        scope,
        description: "Submit build 93ea0f1 to chrome for store review.",
        token,
        api: API_BASE,
        fetchImpl: global.fetch,
      }),
    );

    expect(out.status).toBe("approval-required");
    expect(out.error.name).toBe("ApprovalAlreadyGranted");
    expect(out.value.approvalId).toBe("apr_standing_1");
    expect(out.value.approvalUrl).toBe(`${API_BASE}/device/approve/apr_standing_1`);
    expect(out.hint).toContain("extension_submit with the same arguments and approvalId apr_standing_1 runs it");
    expect(mints()).toBe(1);
  });

  it("mints a fresh approval, marked as the replacement, once the standing one was declined", async () => {
    await ask();
    read = { status: "denied" };

    const out = JSON.parse((await ask() as { envelope: string }).envelope);

    expect(out.status).toBe("approval-required");
    expect(out.value.approvalId).toBe("apr_standing_2");
    expect(out.value.replaces).toEqual(["apr_standing_1"]);
    expect(mints()).toBe(2);
  });
});
