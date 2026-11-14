// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { readWorkspaceBuildAllowance } from "../lib/build-allowance";
import { firstSeenCreating } from "../lib/create-ceiling";
import { readCreateLogin } from "../lib/create-login";
import { findProjectByStoredLogin } from "../lib/created-project-read";
import { rememberCreatedProject } from "../lib/created-projects";
import { writeCredentialBatch } from "../lib/credentials";
import { requestDeviceCode } from "../lib/device-flow";
import { dropHeldBatch, loadHeldBatch, saveHeldBatch } from "../lib/held-batches";
import { heldCreateGrant, holdCreateGrant, releaseCreateGrant } from "../lib/held-create-grant";
import { persistTokenResponse } from "../lib/login-flow";
import { forgetPendingCreate, pendingCreate, rememberPendingCreate } from "../lib/pending-creates";
import { identityHeaders } from "../lib/session-identity";
import { buildSourceArchive, looksLikeExtensionFolder, sourceManifestPath } from "../lib/source-archive";

import type { ProjectCreateLocal, UploadSourceRead } from "./project-create";

function readUploadSource(root: string): UploadSourceRead {
  let folder = false;

  try {
    folder = fs.statSync(root).isDirectory();
  } catch {
  }

  if (!folder) return { kind: "not-folder" };
  if (!sourceManifestPath(root)) return { kind: "no-manifest" };

  return { kind: "archive", archive: buildSourceArchive(root) };
}

function uploadRoot(projectPath: string): string {
  if (projectPath) return path.resolve(projectPath);

  return looksLikeExtensionFolder(process.cwd()) ? process.cwd() : "";
}

export const PROJECT_CREATE_LOCAL: ProjectCreateLocal = {
  cwd: () => process.cwd(),
  uploadRoot,
  readUploadSource,
  requestDeviceCode: (args) => requestDeviceCode(args),
  identityHeaders: (tool) => identityHeaders(tool),
  pendingCreate: (apiBase, project) => pendingCreate(apiBase, project),
  rememberPendingCreate: (apiBase, project, record) => rememberPendingCreate(apiBase, project, record),
  forgetPendingCreate: (apiBase, project) => forgetPendingCreate(apiBase, project),
  heldCreateGrant: (apiBase, deviceCode, ref) => heldCreateGrant(apiBase, deviceCode, ref),
  holdCreateGrant: (apiBase, deviceCode, target, held) => holdCreateGrant(apiBase, deviceCode, target, held),
  releaseCreateGrant: (apiBase, deviceCode) => releaseCreateGrant(apiBase, deviceCode),
  firstSeenCreating: (apiBase, deviceCode, now, kept) => firstSeenCreating(apiBase, deviceCode, now, kept),
  saveHeldBatch: (apiBase, deviceCode, batch) => saveHeldBatch(apiBase, deviceCode, batch),
  loadHeldBatch: (apiBase, deviceCode) => loadHeldBatch(apiBase, deviceCode),
  dropHeldBatch: (apiBase, deviceCode) => dropHeldBatch(apiBase, deviceCode),
  rememberCreatedProject: (apiBase, project) => rememberCreatedProject(apiBase, project),
  persistTokenResponse: (args) => persistTokenResponse(args),
  writeCredentialBatch: (batch) => writeCredentialBatch(batch),
  findProjectByStoredLogin: (args) => findProjectByStoredLogin(args),
  readWorkspaceBuildAllowance: (args) => readWorkspaceBuildAllowance(args),
  readCreateLogin: (args) => readCreateLogin(args),
};
