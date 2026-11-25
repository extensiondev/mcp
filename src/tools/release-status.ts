// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE, waitSecondsInput } from "../lib/common-schema";
import { hostedOnly } from "../lib/hosted-only";

export const schema = {
  name: "extension_release_status",
  description: "Read where a project stands on extension.dev: channels, builds, store submissions and reviews, history, rollout and listings. Answers the sections include names. Read-only; extension_release_promote moves a channel, extension_submit acts on stores, extension_approvals_request asks.",
  inputSchema: {
    type: "object" as const,
    properties: {
      include: {
        type: "array",
        items: {
          type: "string",
          enum: ["releases", "stores", "history", "runs", "rollout", "cut", "listing"],
        },
        default: ["releases", "stores"],
        description: "releases: channels, builds; stores: submissions, reviews; history, runs: owner only; rollout: Chrome; cut: would a release PR build; listing: listings, gaps.",
      },
      since: {
        type: "string",
        description: "runs: earliest ISO date, within 30 days.",
      },
      refresh: {
        type: "array",
        items: {
          type: "string",
          enum: ["chrome", "edge", "firefox", "safari"],
        },
        description: "stores: re-read these stores now (once per two minutes).",
      },
      waitSeconds: waitSecondsInput("refresh: seconds to wait for the check", "0"),
      submissionId: {
        type: "string",
        description: "stores: one submission by id or 8-character prefix.",
      },
      store: {
        type: "string",
        enum: ["chrome", "firefox", "edge", "safari"],
        description: "Only this store.",
      },
      releaseId: {
        type: "string",
        description: "One release, e.g. chrome-stable.",
      },
      workspace: {
        type: "string",
        description: "Workspace slug.",
      },
      project: {
        type: "string",
        description: "Project slug.",
      },
      projectPath: {
        type: "string",
        description: "Project root; picks its project.",
      },
      api: API_BASE,
    },
    required: [],
  },
};

export const handler = hostedOnly(schema.name);
