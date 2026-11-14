import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { TOOL_POLICY } from "../lib/tool-policy";
import { handler as promote, schema } from "../tools/release-promote";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const CUT = `${PROJECT_ROUTE}/releases/cut`;
const ROLLBACK = `${PROJECT_ROUTE}/releases/stable/rollback`;
const APPROVALS = "/api/cli/approvals";
const NOTES = "Fixes the popup on narrow screens.";
const SERVER_CUT = "Open a release pull request in acme/widget-src that bumps the extension's manifest by one minor version. It is armed to release to the Beta channel when someone merges it.";

const digest = (notes: string) =>
  crypto.createHash("sha256").update(JSON.stringify({ notes, dashboardUrl: "" })).digest("hex");

function approvalRequired(action: string, scope: Record<string, string>) {
  return {
    status: 403,
    body: {
      code: "APPROVAL_REQUIRED",
      message: "This act with a token needs a workspace owner's approval.",
      approvalRequest: { action, scope, fingerprint: actionFingerprint(action, scope) },
    },
  };
}

describe("extension_release_promote cuts a release pull request and rolls a channel back, each with an owner's approval", () => {
  const platform = useProjectRoutes("extdev-release-acts-");

  it("offers cut and rollback beside promote, and stays a shipping tool", () => {
    expect(schema.inputSchema.properties.action.enum).toEqual(["promote", "cut", "rollback"]);
    expect(schema.inputSchema.required).toEqual([]);
    expect(TOOL_POLICY.extension_release_promote.ships).toBe("always");
  });
});
