import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler as builds } from "../tools/builds";
import { FILE_APPROVAL_STATE } from "../lib/approval-state-local";
import { forwardSession, forwarderApprovalState } from "../lib/forward-approval-state";
import { forgetForwardCredentials } from "../lib/forward-credential";
import { forwardCall } from "../lib/hosted-forwarder";
import { handler as promote } from "../tools/release-promote";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const LISTING = `${PROJECT_ROUTE}/stores/chrome/listing`;
const CANCEL = `${PROJECT_ROUTE}/stores/chrome/submissions/sub_7f3a/cancel`;
const ROLLBACK = `${PROJECT_ROUTE}/releases/stable/rollback`;
const SETTINGS = `${PROJECT_ROUTE}/settings/build`;
const DISPATCH = `${PROJECT_ROUTE}/builds/dispatch`;
const FULL_SHA = "603fc8a6b1e2d3c4f5a6b7c8d9e0f1a2b3c4d5e6";
const PENDING = { status: 403, body: { code: "APPROVAL_PENDING", message: "This approval has not been granted yet." } };

function listingProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-round-trip-"));
  fs.writeFileSync(path.join(root, "STORE.md"), "# Store metadata\n\n## Listing\n\n- Name: PII Shield\n- Summary: Hide personal information on every open tab.\n");

  return root;
}

describe("on the forwarder path the approvals and held grants are the hosted lane's", () => {
  const xdg = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-round-trip-config-"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    forgetForwardCredentials();
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = xdg;
  });

  it("holds a create grant a local step polled in www's hosted state, and keeps the files outside a forwarded call", async () => {
    const seen: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      seen.push({ url: String(input), method: String(init?.method), authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "null")) });

      if (String(input).endsWith("/exchange")) return new Response(JSON.stringify({ access_token: "forward-1", expires_in: 600 }), { status: 200 });

      if (String(input).endsWith("/mcp/forward")) return new Response(JSON.stringify({ ok: false, status: "local-half", error: { code: "E_TOOL_DISABLED", message: "Polling runs locally." } }), { status: 200 });

      return new Response(JSON.stringify({ held: true }), { status: 200 });
    });

    const deps = { env: {}, version: "11.0.0", resolveLogin: () => ({ token: "device-login", ref: { workspace: "acme", project: "web" } }) };

    const polled = async () => {
      expect(forwardSession()).not.toBeNull();
      await forwarderApprovalState().saveHeldBatch("https://www.extension.dev", "dev-code", { workspace: "acme", refs: ["acme/new"], grant: "grant", grantExpiresAt: 1, rows: [] });

      return "polled here";
    };

    expect(await forwardCall("extension_project_create", { deviceCode: "dev-code" }, polled, deps)).toBe("polled here");
    expect(seen[seen.length - 1]).toEqual({ url: "https://www.extension.dev/api/cli/forward/held-grants", method: "PUT", authorization: "Bearer forward-1", body: { deviceCode: "dev-code", grant: "grant", workspace: "acme", refs: ["acme/new"], rows: [] } });
    expect(forwarderApprovalState()).toBe(FILE_APPROVAL_STATE);
  });

  it("names a state door that answers 503 as closed, never as a grant that does not exist", async () => {
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).endsWith("/exchange")) return new Response(JSON.stringify({ access_token: "forward-1", expires_in: 600 }), { status: 200 });
      if (String(input).endsWith("/mcp/forward")) return new Response(JSON.stringify({ ok: false, status: "local-half", error: { code: "E_TOOL_DISABLED", message: "Polling runs locally." } }), { status: 200 });
      if (String(input).endsWith("/pending-creates")) return new Response(JSON.stringify({ pending: null }), { status: 200 });

      return new Response(JSON.stringify({ code: "HOSTED_STATE_OFF", message: "Hosted state is not enabled on this platform." }), { status: 503 });
    });

    const deps = { env: {}, version: "11.0.0", resolveLogin: () => ({ token: "device-login", ref: { workspace: "acme", project: "web" } }) };

    const state = async () => {
      const closed = await Promise.allSettled([
        forwarderApprovalState().loadHeldBatch("https://www.extension.dev", "dev-code"),
        forwarderApprovalState().saveHeldBatch("https://www.extension.dev", "dev-code", { workspace: "acme", refs: ["acme/new"], grant: "grant", grantExpiresAt: 1, rows: [] }),
        forwarderApprovalState().mintedApproval("https://www.extension.dev", "apr_1"),
      ]);

      for (const outcome of closed) {
        expect(outcome).toMatchObject({ status: "rejected", reason: { name: "ForwardLaneClosedError", code: "HOSTED_STATE_OFF" } });
        expect(String((outcome as PromiseRejectedResult).reason.message)).toMatch(/door is closed.*This login is fine/);
      }

      expect(await forwarderApprovalState().pendingCreate("https://www.extension.dev", "acme/new")).toBeNull();

      return "read here";
    };

    expect(await forwardCall("extension_project_create", { deviceCode: "dev-code" }, state, deps)).toBe("read here");
  });
});
