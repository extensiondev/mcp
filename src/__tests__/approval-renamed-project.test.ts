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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bindApprovalProject, mintedApproval, rememberMintedApproval, renameNote } from "../lib/approval-record";
import { verifyApproval } from "../lib/approval-verify";
import { moveLogin, writeCredentials } from "../lib/credentials";
import { envelope } from "../lib/envelope";
import { annotate } from "../lib/tool-dispatch";

const API = "http://localhost:3100";
const APPROVAL_ID = "apr_J3pJzcFuh6UWFwP_AMwl_IZ085Ookc_R";
const FRESH_ID = "apr_rS0P0RbO3UsOyG3zy4DN4NQHxlixx7Kt";
const LEON_ID = "prj_a017a32f";
const REBECCAT_ID = "prj_5c3e9b10";
const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];
const saved: Record<string, string | undefined> = {};
let tmp: string;

function tokenFor(workspace: string, project: string): string {
  return `${Buffer.from(JSON.stringify({ u: workspace, p: project })).toString("base64url")}.sig`;
}

function storedLogin(projectSlug: string, projectId: string): void {
  writeCredentials({
    version: 1,
    token: tokenFor("acme", projectSlug),
    workspaceSlug: "acme",
    projectSlug,
    projectId,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    api: API,
    provider: "extensiondev",
  });
}

function mint(projectSlug: string, approvalId = APPROVAL_ID) {
  return rememberMintedApproval({
    api: API,
    token: tokenFor("acme", projectSlug),
    approvalId,
    action: "extension_settings.build",
    fingerprint: "f".repeat(64),
    approvalUrl: `${API}/device/approve/${approvalId}`,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
}

function renamedLeon(): void {
  storedLogin("leon", LEON_ID);
  mint("leon");
  moveLogin({ workspaceSlug: "acme", fromProjectSlug: "leon", toProjectSlug: "lion", api: API, projectId: LEON_ID });
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-approval-renamed-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  delete process.env.EXTENSION_DEV_TOKEN;
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

describe("an approval is bound to the project by its id, not by the slug the token carried", () => {
  it("records the prj_ id of the minting project beside its slug", () => {
    storedLogin("leon", LEON_ID);

    expect(mint("leon")).toMatchObject({ workspace: "acme", project: "leon", projectId: LEON_ID });
    expect(mintedApproval(API, APPROVAL_ID)?.projectId).toBe(LEON_ID);
  });

  it("records no id when the token has no stored login to read one from", () => {
    expect(mint("leon")).not.toHaveProperty("projectId");
  });

  it("passes a retry that names the new slug of the same project and says it was renamed", () => {
    renamedLeon();

    const args = { approvalId: APPROVAL_ID, project: "acme/lion", api: API, action: "configure" };
    const bound = bindApprovalProject("extension_builds", args);

    expect(bound).toEqual({ args, note: renameNote("acme/leon", "acme/lion") });
    expect("note" in bound && bound.note).toBe("The project was renamed from acme/leon to acme/lion since the approval was minted.");
  });

  it("resolves a bare new slug in the minted workspace", () => {
    renamedLeon();

    const bound = bindApprovalProject("extension_builds", { approvalId: APPROVAL_ID, project: "lion", api: API });

    expect("note" in bound && bound.note).toBe(renameNote("acme/leon", "acme/lion"));
  });

  it("still refuses a retry for a genuinely different project", () => {
    renamedLeon();
    storedLogin("rebeccat", REBECCAT_ID);

    const bound = bindApprovalProject("extension_builds", { approvalId: APPROVAL_ID, project: "acme/rebeccat", api: API });

    expect("refused" in bound).toBe(true);
    const out = JSON.parse("refused" in bound ? bound.refused : "{}");
    expect(out.error).toMatchObject({ name: "ApprovalOtherProject" });
    expect(out.value).toMatchObject({ mintedFor: "acme/leon", named: "acme/rebeccat" });
  });

  it("refuses a slug this machine has no id for", () => {
    renamedLeon();

    const bound = bindApprovalProject("extension_builds", { approvalId: APPROVAL_ID, project: "acme/ghost", api: API });

    expect("refused" in bound).toBe(true);
  });

  it("marks the old record replaced when the same act is minted again under the new slug", () => {
    renamedLeon();

    const fresh = mint("lion", FRESH_ID);

    expect(fresh?.replaces).toEqual([APPROVAL_ID]);
    expect(mintedApproval(API, APPROVAL_ID)?.replacedBy).toBe(FRESH_ID);
  });

  it("names the rename instead of another project when the platform forgot the approval", async () => {
    renamedLeon();

    const doFetch = vi.fn(async () => new Response(JSON.stringify({ code: "APPROVAL_UNKNOWN", message: "Unknown approval" }), { status: 404 }));
    const result = await verifyApproval({
      base: API,
      fingerprint: "f".repeat(64),
      input: {
        command: "extension_builds",
        action: "extension_settings.build",
        scope: {},
        description: "Change the build settings of lion.",
        approvalId: APPROVAL_ID,
        token: tokenFor("acme", "lion"),
        api: API,
      },
      doFetch: doFetch as unknown as typeof fetch,
      minted: mintedApproval(API, APPROVAL_ID),
    });

    expect(result.blocked).toBe(true);
    const out = JSON.parse(result.blocked ? result.envelope : "{}");
    expect(out.error.name).toBe("ApprovalUnknown");
    expect(out.error.message).toContain("for acme/leon (now acme/lion), the project this machine minted it for");
    expect(out.error.message).not.toContain("this call resolved");
  });
});

describe("the rename note rides the answer the retry produces", () => {
  it("lands in value.note beside what the tool answered", () => {
    const answered = envelope({ ok: true, command: "extension_builds", status: "configured", value: { note: "Nothing else changed." }, hint: "Done." });

    const out = JSON.parse(annotate(answered, { note: renameNote("acme/leon", "acme/lion") }));

    expect(out.value.note).toBe(`Nothing else changed. ${renameNote("acme/leon", "acme/lion")}`);
    expect(out.hint).toBe("Done.");
    expect(out.ok).toBe(true);
  });

  it("leaves an answer alone without a note", () => {
    const answered = envelope({ ok: true, command: "extension_builds", status: "configured" });

    expect(annotate(answered, {})).toBe(answered);
  });
});
