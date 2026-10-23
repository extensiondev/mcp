import { describe, expect, it } from "vitest";

import { evaluateApproval } from "../lib/approval-gate";
import { APPROVAL_POLICY, approvalVerdict, isPolicyAct, publicSubmissionMode, verdictOfAction } from "../lib/approval-policy";

const RULED_TABLE: Array<[keyof typeof APPROVAL_POLICY, "plain" | "approval" | "console"]> = [
  ["extension_settings.build", "plain"],
  ["extension_settings.store", "plain"],
  ["extension_store.listing", "plain"],
  ["extension_builds.rebuild", "plain"],
  ["extension_builds.recheck", "plain"],
  ["extension_builds.create-channel", "plain"],
  ["extension_builds.configure-channel", "plain"],
  ["extension_project.visibility", "plain"],
  ["extension_settings.project", "plain"],
  ["extension_settings.environment", "plain"],
  ["extension_submit", "approval"],
  ["extension_store.publish", "approval"],
  ["extension_store.cancel", "approval"],
  ["extension_store.rollout", "approval"],
  ["extension_release_promote", "approval"],
  ["extension_release.cut", "approval"],
  ["extension_release.rollback", "approval"],
  ["extension_shares.revoke", "approval"],
  ["extension_shares.public", "approval"],
  ["extension_builds.channel-audience", "approval"],
  ["extension_settings.store-public-mode", "approval"],
  ["extension_project.visibility-public", "approval"],
  ["extension_store.disconnect", "console"],
  ["extension_builds.delete-channel", "console"],
  ["extension_project.delete", "console"],
  ["extension_store.credentials", "console"],
  ["extension_settings.environment-secret", "console"],
];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("the approval policy table holds Cezar's ruling of 2026-10-23 (ledger 143, closing 137 and 139)", () => {
  it("names every act with its ruled verdict, and no other act", () => {
    expect(RULED_TABLE.map(([act, verdict]) => [act, APPROVAL_POLICY[act], verdict])).toEqual(RULED_TABLE.map(([act, verdict]) => [act, verdict, verdict]));
    expect(Object.keys(APPROVAL_POLICY).sort()).toEqual(RULED_TABLE.map(([act]) => act).sort());
  });

  it("keeps a listed or public submission mode on the approve page while the other store settings are plain", () => {
    expect(approvalVerdict("extension_settings.store", { submissionMode: "draft" })).toBe("plain");
    expect(approvalVerdict("extension_settings.store", { submissionMode: "unlisted" })).toBe("plain");
    expect(approvalVerdict("extension_settings.store", { releaseChannel: "unlisted" })).toBe("plain");
    expect(approvalVerdict("extension_settings.store", { submissionMode: "listed" })).toBe("approval");
    expect(approvalVerdict("extension_settings.store", { submissionMode: "public" })).toBe("approval");
    expect(approvalVerdict("extension_settings.store", { releaseChannel: "listed" })).toBe("approval");
    expect(publicSubmissionMode({ submissionMode: "Public" })).toBe(true);
    expect(publicSubmissionMode({})).toBe(false);
  });

  it("keeps a public channel audience on the approve page while a private channel is plain, at creation and on an existing channel", () => {
    expect(approvalVerdict("extension_builds.create-channel")).toBe("plain");
    expect(approvalVerdict("extension_builds.create-channel", { audience: "private" })).toBe("plain");
    expect(approvalVerdict("extension_builds.create-channel", { audience: "public" })).toBe("approval");
    expect(approvalVerdict("extension_builds.configure-channel")).toBe("plain");
    expect(approvalVerdict("extension_builds.configure-channel", { audience: "private" })).toBe("plain");
    expect(approvalVerdict("extension_builds.configure-channel", { audience: "Public" })).toBe("approval");
    expect(approvalVerdict("extension_builds.delete-channel")).toBe("console");
  });

  it("keeps a public project visibility on the approve page while a private one is plain", () => {
    expect(approvalVerdict("extension_project.visibility")).toBe("plain");
    expect(approvalVerdict("extension_project.visibility", { visibility: "private" })).toBe("plain");
    expect(approvalVerdict("extension_project.visibility", { visibility: "public" })).toBe("approval");
    expect(approvalVerdict("extension_project.visibility", { visibility: "Public" })).toBe("approval");
  });

  it("keeps a live channel whose recorded audience is public on the approve page through the channel-audience row, while every other project setting is plain", () => {
    expect(approvalVerdict("extension_settings.project")).toBe("plain");
    expect(approvalVerdict("extension_settings.project", { audience: "private" })).toBe("plain");
    expect(approvalVerdict("extension_settings.project", { audience: "public" })).toBe("approval");
    expect(approvalVerdict("extension_settings.environment")).toBe("plain");
    expect(approvalVerdict("extension_settings.environment-secret")).toBe("console");
  });

  it("treats an act the table does not name as one that needs an approval", () => {
    expect(isPolicyAct("extension_settings.build")).toBe(true);
    expect(isPolicyAct("extension_unknown")).toBe(false);
    expect(verdictOfAction("extension_unknown")).toBe("approval");
  });

  it("never mints an approval for a plain act on its own, and mints when the platform asked", async () => {
    const posts: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      posts.push(`${String(init?.method ?? "GET")} ${new URL(String(url)).pathname}`);

      return jsonResponse({ approvalId: "apr_p", approvalUrl: "https://www.extension.dev/device/approve/apr_p" }, 201);
    }) as unknown as typeof fetch;
    const input = {
      command: "extension_builds",
      action: "extension_settings.build",
      scope: { settingsDigest: "0".repeat(64) },
      description: "Change the build settings of acme/widget.",
      token: "tok",
      api: "http://localhost:3100",
      enabled: true,
      fetchImpl,
    };

    const plain = await evaluateApproval(input);

    expect(plain).toEqual({ blocked: false });
    expect(posts).toEqual([]);

    const asked = await evaluateApproval({ ...input, platformAsked: true });

    expect(asked.blocked).toBe(true);
    expect(posts).toEqual(["POST /api/cli/approvals"]);
  });

  it("never mints an approval for a console act, and says so without reaching the platform", async () => {
    const posts: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      posts.push(`${String(init?.method ?? "GET")} ${new URL(String(url)).pathname}`);

      return jsonResponse({});
    }) as unknown as typeof fetch;

    const gate = await evaluateApproval({
      command: "extension_submit",
      action: "extension_store.credentials",
      scope: { store: "firefox" },
      description: "Save the Firefox store credentials of acme/widget.",
      token: "tok",
      api: "http://localhost:3100",
      enabled: true,
      fetchImpl,
    });

    expect(gate.blocked).toBe(true);
    const out = JSON.parse(gate.blocked ? gate.envelope : "{}");

    expect(out.status).toBe("console-only");
    expect(out.error.name).toBe("ConsoleOnly");
    expect(out.error.message).toContain("never runs from here");
    expect(posts).toEqual([]);
  });
});
