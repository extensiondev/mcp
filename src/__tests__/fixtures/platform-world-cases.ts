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

import { actionFingerprint } from "../../lib/approval-gate";
import { FULL_SHA, MIRROR_RUN_URL, WORLD_API, type World } from "./platform-world";

type Row = Record<string, unknown>;

export interface WorldCase {
  name: string;
  args: Row | (() => Row);
  login?: boolean;
  setup?: (world: World) => void;
  approval?: boolean;
}

const P = "/api/projects/prj_world";
const WORLD_APPROVAL_ID = `apr_${"W".repeat(32)}`;

const approvalAsked = (action: string, scope: Row) => ({
  status: 403,
  body: {
    code: "APPROVAL_REQUIRED",
    message: "A workspace owner must approve this.",
    approvalRequest: { action, scope, fingerprint: actionFingerprint(action, scope as never) },
  },
});

function listingProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-world-listing-"));
  fs.writeFileSync(path.join(root, "STORE.md"), "# Store metadata\n\n## Listing\n\n- Name: PII Shield\n- Summary: Hide personal information on every open tab.\n");

  return root;
}

const api = { api: WORLD_API };
const SHARE_ID = `gen_${"ab".repeat(32)}`;

function distProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-world-dist-"));
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ name: "Widget", version: "1.0.0", manifest_version: 3, action: { default_popup: "popup.html" } }));
  fs.writeFileSync(path.join(root, "popup.html"), "<p>hi</p>");
  distProject.last = root;

  return root;
}
distProject.last = "";
const PENDING = { status: 403, body: { code: "APPROVAL_PENDING", message: "This approval has not been granted yet." } };

export const WORLD_CASES: Record<string, WorldCase[]> = {
  extension_builds: [
    { name: "list", args: { action: "list", ...api } },
    { name: "get", args: { action: "get", buildId: "603fc8a", ...api } },
    { name: "logs", args: { action: "logs", buildId: "603fc8a", browser: "chrome", ...api } },
    { name: "rebuild", args: { action: "rebuild", buildId: FULL_SHA, ...api } },
    {
      name: "rebuild approval",
      approval: true,
      args: { action: "rebuild", buildId: FULL_SHA, ...api },
      setup: (world) => {
        world.routes.push([new RegExp(`^POST ${P}/builds/dispatch$`), () => approvalAsked("extension_builds.rebuild", { commit: FULL_SHA, buildEnv: "staging" })]);
      },
    },
    {
      name: "configure approval",
      approval: true,
      args: { action: "configure", buildSettings: { firefox: { buildCommand: "pnpm build" } }, approvalId: "apr_cfg", ...api },
      setup: (world) => {
        world.routes.push([/^GET \/api\/cli\/approvals\/apr_cfg$/, () => ({ body: { status: "pending", used: false } })]);
      },
    },
    { name: "configure", args: { action: "configure", buildSettings: { firefox: { buildCommand: "pnpm build" } }, ...api } },
    { name: "create-channel", args: { action: "create-channel", channel: "nightly", ...api } },
  ],
  extension_release_promote: [
    { name: "promote", args: { buildId: "603fc8a", channel: "beta", ...api } },
    {
      name: "promote approval",
      approval: true,
      args: { buildId: "603fc8a", channel: "beta", ...api },
      setup: (world) => {
        world.routes.push([/^POST \/api\/cli\/release\/promote$/, () => ({ status: 403, body: { code: "APPROVAL_REQUIRED", message: "A workspace owner must approve this promote." } })]);
      },
    },
    {
      name: "promote pending",
      approval: true,
      args: { buildId: "603fc8a", channel: "stable", approvalId: "apr_p", ...api },
      setup: (world) => {
        world.routes.push([/^GET \/api\/cli\/approvals\/apr_p$/, () => ({ body: { status: "pending", used: false } })]);
      },
    },
    {
      name: "rollback pending",
      approval: true,
      args: { action: "rollback", channel: "stable", approvalId: "apr_rb", ...api },
      setup: (world) => {
        world.routes.push([new RegExp(`^POST ${P}/releases/stable/rollback$`), () => PENDING]);
      },
    },
    {
      name: "cut pending",
      approval: true,
      args: { action: "cut", level: "patch", approvalId: "apr_cut", ...api },
      setup: (world) => {
        world.routes.push([new RegExp(`^POST ${P}/releases/cut$`), () => PENDING]);
      },
    },
  ],
  extension_release_status: [
    { name: "releases", args: { include: ["releases"], ...api } },
    { name: "runs", args: { include: ["runs"], ...api } },
  ],
  extension_submit: [
    { name: "preflight", args: { action: "preflight", browsers: ["chrome"], ...api } },
    {
      name: "sync-listing approval",
      approval: true,
      args: () => ({ action: "sync-listing", browsers: ["chrome"], projectPath: listingProject(), approvalId: "apr_sync", ...api }),
      setup: (world) => {
        world.routes.push([new RegExp(`^PUT ${P}/stores/chrome/listing$`), () => PENDING]);
      },
    },
    {
      name: "configure-store pending",
      approval: true,
      args: { action: "configure-store", store: "firefox", storeSettings: { enabled: true, sourceArchive: "repository" }, approvalId: "apr_cfg", ...api },
      setup: (world) => {
        world.routes.push([/^GET \/api\/cli\/approvals\/apr_cfg$/, () => ({ body: { status: "pending", used: false } })]);
      },
    },
    {
      name: "cancel approval",
      approval: true,
      args: { action: "cancel", submissionId: "sub_1", approvalId: "apr_cancel", ...api },
      setup: (world) => {
        world.routes.push([new RegExp(`^POST ${P}/stores/chrome/submissions/sub_1/cancel$`), () => PENDING]);
      },
    },
    {
      name: "rollout pending",
      approval: true,
      args: { action: "rollout", deployPercentage: 50, approvalId: "apr_roll", ...api },
      setup: (world) => {
        world.routes.push([new RegExp(`^POST ${P}/stores/chrome/rollout$`), () => PENDING]);
      },
    },
    {
      name: "submit pending",
      approval: true,
      args: { browsers: ["chrome"], buildSha: "603fc8a", dryRun: false, approvalId: "apr_s", ...api },
      setup: (world) => {
        world.routes.push([/^GET \/api\/cli\/approvals\/apr_s$/, () => ({ body: { status: "pending", used: false } })]);
      },
    },
    { name: "dry run", args: { browsers: ["chrome"], buildSha: "603fc8a", ...api } },
  ],
  extension_publish: [{ name: "publish", args: { ...api } }],
  extension_approvals: [
    {
      name: "status",
      args: { approvalId: WORLD_APPROVAL_ID, ...api },
      setup: (world) => {
        world.routes.push([new RegExp(`^GET /api/cli/approvals/${WORLD_APPROVAL_ID}$`), () => ({ body: { status: "approved", used: false, fingerprint: "f".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" } })]);
      },
    },
    {
      name: "revoke",
      args: { action: "revoke", approvalId: WORLD_APPROVAL_ID, ...api },
      setup: (world) => {
        world.routes.push([new RegExp(`^POST /api/cli/approvals/${WORLD_APPROVAL_ID}/revoke$`), () => ({ body: { status: "revoked", approvalId: WORLD_APPROVAL_ID, revokedBy: "acme", revokedAt: "2026-10-28T14:00:00.000Z" } })]);
        world.routes.push([new RegExp(`^GET /api/cli/approvals/${WORLD_APPROVAL_ID}$`), () => ({ status: 410, body: { code: "APPROVAL_REVOKED", revokedBy: "acme" } })]);
      },
    },
  ],
  extension_shares: [
    { name: "list", args: { action: "list", ...api } },
    { name: "revoke approval", approval: true, args: { action: "revoke", artifactId: SHARE_ID, ...api } },
  ],
  extension_preview_web: [
    {
      name: "share",
      args: () => ({ projectPath: distProject(), distPath: distProject.last, build: false, probe: false, share: true }),
      setup: () => {
        process.env.EXTENSION_DEV_API_URL = WORLD_API;
      },
    },
  ],
  extension_workspace: [
    { name: "info", args: { action: "info", ...api } },
    { name: "settings", args: { action: "settings", ...api } },
  ],
  extension_workspace_create: [{ name: "create pending", approval: true, login: false, args: { workspace: "acme2", ...api } }],
  extension_project_create: [{ name: "create pending", approval: true, login: false, args: { project: "acme/fresh", repo: "acme/fresh", ...api } }],
  extension_auth: [
    { name: "status", args: { action: "status", ...api } },
    { name: "login pending", approval: true, login: false, args: { action: "login", project: "acme/widget", ...api } },
    { name: "logout", args: { action: "logout", project: "acme/widget", ...api } },
  ],
};

export { MIRROR_RUN_URL };
