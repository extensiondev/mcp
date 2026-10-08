// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler } from "../tools/submit";

function claimsToken(u: string, p: string): string {
  return `${Buffer.from(JSON.stringify({ u, p, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
}

function jsonResponse(body: unknown, status: number): Response {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

const saved: Record<string, string | undefined> = {};
let prevFetch: typeof fetch;

beforeEach(() => {
  for (const key of ["EXTENSION_DEV_APPROVAL_GATE", "EXTENSION_DEV_TOKEN"]) saved[key] = process.env[key];
  process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
  process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
  prevFetch = global.fetch;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  global.fetch = prevFetch;
});

async function refusedWith(code: string): Promise<{ hint?: string; warnings?: string[] }> {
  global.fetch = (async () => jsonResponse({ code, message: `refused: ${code}` }, 422)) as unknown as typeof fetch;

  return JSON.parse(
    await handler({ browsers: ["chrome"], buildSha: "abc1234", dryRun: false, approvalId: "apr_1" }),
  );
}

describe("an approval is spent before the quota and channel checks: the platform consumes a presented approvalId once the owner, runner and dispatch-pause checks pass", () => {
  it("says the approval was spent when the refusal came after those checks", async () => {
    const result = await refusedWith("QUOTA_EXCEEDED");

    expect(String(result.hint)).toContain("was spent by the platform before this refusal");
  });

  it("does not say so when the refusal is one of the checks that run before the approval is consumed", async () => {
    const result = await refusedWith("APPROVAL_REQUIRED");

    expect(JSON.stringify(result)).not.toContain("was spent");
  });
});
