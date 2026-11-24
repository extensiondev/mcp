// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE, SUBMIT_WAIT_SECONDS } from "../lib/common-schema";
import { PROJECT_TOKEN_INPUT } from "../lib/credentials";
import { hostedOnly } from "../lib/hosted-only";

import type { InputIssue } from "../lib/validate-input";

export const schema = {
  name: "extension_submit",
  description: "Submit an extension.dev build to the Chrome, Firefox, Edge and Safari stores. It runs the call carrying an approvalId; extension_submit_check answers the preflight and asks the approval, extension_release_status answers reviews, extension_release_promote moves a channel. A real submit needs a workspace owner's token and approval of that exact submission, every time. Uploads land least public (Chrome and Edge drafts, Firefox unlisted, Safari TestFlight) unless a saved store mode says otherwise.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [
          "submit",
          "status",
          "preflight",
          "sync-listing",
          "cancel",
          "rollout",
          "release",
          "publish",
          "review",
          "configure-store",
          "connect",
          "first-submission",
          "mint-signing",
        ],
        default: "submit",
        description: "'preflight', 'status' and submit with dryRun true are read-only; submit with dryRun:false and no approvalId executes nothing either, it only asks the owner's approval, as does the first call of any store act. submit: buildSha to the stores. preflight: readiness checks. status: each store's word. sync-listing: listing from STORE.md. publish (alias review): draft to review. release (Safari): approved version on sale. cancel: withdraw from review. rollout: raise Chrome's staged rollout. configure-store: storeSettings. connect: page where the person gives the platform the key. first-submission: page for a first Chrome or Edge upload. mint-signing (Safari): register the bundle id, mint certificates and profiles.",
      },
      project: PROJECT_TOKEN_INPUT,
      workspace: {
        type: "string",
        description: "connect: a workspace, for its shared account.",
      },
      browsers: {
        type: "array",
        items: {
          type: "string",
          enum: ["chrome", "firefox", "edge", "safari"],
        },
        description: "Stores; submit, publish and sync-listing take several under one approval.",
      },
      buildSha: {
        type: "string",
        description: "Commit sha of a completed platform build (extension_builds_read).",
      },
      version: {
        type: "string",
        description: "Label; default the built manifest's version.",
      },
      dryRun: {
        type: "boolean",
        default: true,
        description: "true sends nothing and spends no approval or quota; false submits once approved and stops at the draft under the default modes.",
      },
      projectPath: {
        type: "string",
        description: "Project root, for sync-listing; nothing local is uploaded.",
      },
      approvalId: {
        type: "string",
        description: "Once approved, with the same arguments; a real submission needs a workspace owner's approval every time.",
      },
      screenshots: {
        type: "array",
        items: {
          type: "string",
        },
        description: "sync-listing: PNG screenshots in projectPath.",
      },
      useBuild: {
        type: "string",
        description: "sync-listing: a completed build's sha for icons.",
      },
      detail: {
        type: ["boolean", "array"],
        items: {
          type: "string",
        },
        description: "preflight: true, or [\"chrome\", \"safari.subtitle\"], answers those rows in full.",
      },
      api: API_BASE,
      store: {
        type: "string",
        enum: ["chrome", "firefox", "edge", "safari"],
        description: "cancel, rollout (default chrome), release (safari), configure-store (required).",
      },
      storeSettings: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            description: "Submit to this store at all.",
          },
          submissionMode: {
            type: "string",
            description: "chrome draft-until-public|draft|public|staged, edge draft|review, firefox unlisted|listed, safari draft|review, or dry-run; public, staged, review and listed publish on review.",
          },
          sourceArchive: {
            type: "string",
            enum: ["repository", "project", "none"],
            description: "Firefox sources: repo, or folder + packages.",
          },
          releaseChannel: {
            type: "string",
            enum: ["listed", "unlisted"],
            description: "Firefox: the AMO channel.",
          },
          chromeItemId: {
            type: "string",
            description: "The 32-letter item id.",
          },
          publisherId: {
            type: "string",
            description: "Chrome: the publisher id after /devconsole/.",
          },
          edgeProductId: {
            type: "string",
            description: "The Partner Center Product ID.",
          },
          firefoxAddonGuid: {
            type: "string",
            description: "The add-on GUID, never a slug.",
          },
          appStoreId: {
            type: "string",
            description: "Safari: the app's Apple ID.",
          },
          bundleId: {
            type: "string",
            description: "Safari: the reverse-DNS bundle id.",
          },
          firstSubmitted: {
            type: "boolean",
            description: "Edge: submitted once in Partner Center.",
          },
          storeUrl: {
            type: "string",
            description: "Edge listing or Chrome dashboard URL; \"\" clears.",
          },
          dashboardPasted: {
            type: "boolean",
            description: "Chrome: dashboard-only fields pasted.",
          },
        },
        description: "configure-store: only what changes; a publishing mode asks approval; no credentials; Safari release mode is STORE.md's `- Release:` line.",
      },
      submissionId: {
        type: "string",
        description: "cancel, publish, release: the submission; default newest.",
      },
      buildNumber: {
        type: "integer",
        minimum: 1,
        description: "Safari publish or release: TestFlight build number (default newest).",
      },
      deployPercentage: {
        type: "number",
        description: "rollout: new share of users, 1 to 100, above the current one.",
      },
      connectSession: {
        type: "string",
        description: "connect: value.connectSession to wait on with waitSeconds.",
      },
      replace: {
        type: "boolean",
        description: "connect: true replaces a working key; only when asked.",
      },
      waitSeconds: SUBMIT_WAIT_SECONDS,
    },
    required: [],
  },
};

export const SUBMIT_ACTIONS = schema.inputSchema.properties.action.enum;

export function invalidArgumentsHint(issues: InputIssue[]): string | undefined {
  if (!issues.some((issue) => issue.path === "action")) return undefined;

  return "The store's own state for the newest version is extension_submit_check {action: \"status\", browsers: [<store>]}, and the full store picture is extension_release_status {include: [\"stores\"]}.";
}

export const handler = hostedOnly(schema.name);
