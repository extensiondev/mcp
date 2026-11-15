// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { resolveCredential } from "../lib/credential-source";
import { PROJECT_TOKEN_INPUT } from "../lib/credentials";
import { hostedOnly } from "../lib/hosted-only";
import { createShareFromBuild, type SharesLocal } from "./shares-create";
import { SHARES_LOCAL, listRecordedShares } from "./shares-local";

export const schema = {
  name: "extension_shares",
  description: "List, create and revoke emulator preview links for a tester, and list and revoke build links (a build link or channel link comes from extension_publish). A revoke is permanent and needs an owner's approval.",
  inputSchema: {
    type: "object" as const,
    properties: {
      project: PROJECT_TOKEN_INPUT,
      kind: {
        type: "string",
        enum: ["build-link", "preview", "both"],
        default: "both",
        description: "Which kind of share.",
      },
      tokenId: {
        type: "string",
        description: "revoke: a build link's tokenId.",
      },
      action: {
        type: "string",
        enum: ["list", "create", "revoke"],
        default: "list",
        description: "create: share a build; revoke: one share, for good.",
      },
      buildId: {
        type: "string",
        description: "create: build commit sha.",
      },
      browser: {
        type: "string",
        description: "create: browser (default chrome).",
      },
      artifactId: {
        type: "string",
        description: "revoke: the gen_... id.",
      },
      url: {
        type: "string",
        description: "revoke: any URL of the share.",
      },
      approvalId: {
        type: "string",
        description: "revoke: approved approval id.",
      },
      projectPath: {
        type: "string",
        description: "Project root.",
      },
      status: {
        type: "string",
        enum: ["all", "live"],
        default: "all",
        description: "all or live.",
      },
      limit: {
        type: "number",
        description: "1 to 200 (default 100).",
      },
      api: API_BASE,
    },
    required: [],
  },
};

export interface SharesCreateArgs extends Record<string, unknown> {
  action?: string;
  buildId?: string;
  browser?: string;
  project?: string;
  projectPath?: string;
  api?: string;
}

function listsFromRecord(args: Record<string, unknown>): boolean {
  return (args.action === undefined || args.action === "list") && typeof args.projectPath === "string" && args.projectPath.trim() !== "";
}

export async function sharesWith(args: SharesCreateArgs, local: SharesLocal): Promise<string> {
  if (listsFromRecord(args) && !resolveCredential({ project: args.project, api: args.api }).token) {
    return listRecordedShares({ projectPath: String(args.projectPath), project: args.project, api: args.api });
  }

  if (args.action !== "create") return hostedOnly(schema.name)(args);

  return createShareFromBuild({ buildId: args.buildId, browser: args.browser, project: args.project, api: args.api }, local);
}

export async function handler(args: SharesCreateArgs): Promise<string> {
  return sharesWith(args, SHARES_LOCAL);
}
