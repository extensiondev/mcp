import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { approvalRoundTrip } from "../lib/approval-outcome";
import { evaluateApproval } from "../lib/approval-gate";
import { handler } from "../tools/approvals";

const ID = `apr_${"XPg37v7ERigO-LGd2YNhto1cC3H_vCJP"}`;
const DESCRIPTION = "Send App Store version 0.2.0 with TestFlight build 11 to Apple's App Review";
const saved: Record<string, string | undefined> = {};
let tmp: string;

type Call = { method: string; url: string; authorization: string };

function platform(routes: Record<string, { status: number; body: Record<string, unknown> }>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: RequestInit) => {
      const method = String(init?.method || "GET");
      const pathname = new URL(String(url)).pathname;
      calls.push({ method, url: pathname, authorization: String((init?.headers as Record<string, string>)?.authorization) });
      const route = routes[`${method} ${pathname}`] ?? { status: 404, body: { code: "NOT_ROUTED" } };

      return new Response(JSON.stringify(route.body), { status: route.status });
    }),
  );

  return calls;
}

const READ = `/api/cli/approvals/${ID}`;
const REVOKED_READ = {
  status: 410,
  body: { code: "APPROVAL_REVOKED", message: "This approval was revoked by rebeccat at 2026-10-28T14:00:00.000Z, so it can no longer be used and nothing ran with it.", revokedBy: "rebeccat", revokedAt: "2026-10-28T14:00:00.000Z", kind: "extension_store.publish", fingerprint: "f".repeat(64) },
};

beforeEach(() => {
  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"]) saved[key] = process.env[key];

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-approvals-revoke-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = "https://api.test";
  process.env.EXTENSION_DEV_TOKEN = "env-token";
  delete process.env.EXTENSION_DEV_PROJECT;
});

afterEach(() => {
  vi.unstubAllGlobals();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the approval gate refuses a revoked approval plainly", () => {
  it("answers approval-revoked naming who revoked it, and never calls the act", async () => {
    const calls = platform({ [`GET ${READ}`]: REVOKED_READ });

    const gate = await evaluateApproval({
      command: "extension_submit",
      action: "extension_store.publish",
      scope: { store: "safari" },
      description: DESCRIPTION,
      approvalId: ID,
      token: "env-token",
      enabled: true,
    });

    expect(gate.blocked).toBe(true);
    const out = JSON.parse((gate as { envelope: string }).envelope);
    expect(out).toMatchObject({
      status: "approval-revoked",
      error: { name: "ApprovalRevoked", code: "E_APPROVAL_REJECTED" },
      value: { approvalId: ID, revokedBy: "rebeccat" },
    });

    expect(out.error.message).toContain(`Approval ${ID} was revoked by rebeccat at 2026-10-28T14:00:00.000Z, so nothing was executed`);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("maps a spend the platform refused as revoked to approval-revoked", () => {
    const out = JSON.parse(
      approvalRoundTrip({
        command: "extension_submit",
        platformCode: "APPROVAL_REVOKED",
        message: "This approval was revoked by rebeccat, so it can no longer be used and nothing ran with it.",
        approvalId: ID,
        undone: "Nothing was submitted.",
      })!,
    );

    expect(out).toMatchObject({ status: "approval-revoked", error: { name: "ApprovalRevoked", platformCode: "APPROVAL_REVOKED" } });
    expect(out.hint).toContain("revoked this approval");
  });
});
