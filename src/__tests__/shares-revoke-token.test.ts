import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeCredentials } from "../lib/credentials";
import { handler } from "../tools/shares";

const FULL_ID = `gen_${"0123456789abcdef".repeat(4)}`;
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const saved: Record<string, string | undefined> = {};
let tmp: string;

function login(projectSlug: string) {
  writeCredentials({
    version: 1,
    token: `tok-${projectSlug}`,
    workspaceSlug: "acme",
    projectSlug,
    expiresAt: FUTURE,
    api: "https://api.test",
    provider: "extensiondev",
  });
}

beforeEach(() => {
  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_APPROVAL_GATE"]) {
    saved[key] = process.env[key];
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-shares-revoke-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = "https://api.test";
  process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
  delete process.env.EXTENSION_DEV_PROJECT;
  process.env.EXTENSION_DEV_TOKEN = "env-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function captureDelete(body: unknown = { artifactId: FULL_ID, revoked: true }, status = 200) {
  const headers: Array<Record<string, string>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: any, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return headers;
}

describe("extension_shares revoke sends the named project's token", () => {
  it("revokes with the login named by project, not the active one or the env token", async () => {
    login("beta");
    login("alpha");
    const headers = captureDelete();

    const out = JSON.parse(await handler({ action: "revoke", artifactId: FULL_ID, project: "acme/beta" }));

    expect(out.status).toBe("revoked");
    expect(headers).toHaveLength(1);
    expect(headers[0]?.authorization).toBe("Bearer tok-beta");
  });

  it("refuses before sending when the named project has no stored login", async () => {
    login("alpha");
    const headers = captureDelete();

    const out = JSON.parse(await handler({ action: "revoke", artifactId: FULL_ID, project: "acme/gamma" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("auth-required");
    expect(out.error.message).toContain("acme/gamma");
    expect(headers).toHaveLength(0);
  });

  it("reads APPROVAL_NOT_FOUND on a 404 as a refused approval over a live share", async () => {
    login("alpha");
    captureDelete({ message: "Approval not found", code: "APPROVAL_NOT_FOUND" }, 404);

    const out = JSON.parse(await handler({ action: "revoke", artifactId: FULL_ID, approvalId: "apr_x" }));

    expect(out.ok).toBe(false);
    expect(out.error.message).toContain("APPROVAL_NOT_FOUND");
    expect(out.error.message).not.toContain("already revoked");
    expect(out.error.message).toContain("not touched");
  });

  it("says a 401 is a refused token, not a missing one", async () => {
    login("alpha");
    captureDelete({ message: "Token revoked", code: "TOKEN_REVOKED" }, 401);

    const out = JSON.parse(await handler({ action: "revoke", artifactId: FULL_ID }));

    expect(out.ok).toBe(false);
    expect(out.error.message).toContain("refused the token");
    expect(out.error.message).toContain("TOKEN_REVOKED");
    expect(out.error.message).not.toContain("No token");
  });
});
