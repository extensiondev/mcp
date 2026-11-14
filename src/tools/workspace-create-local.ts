// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { creatingAge } from "../lib/create-ceiling";
import { requestDeviceCode } from "../lib/device-flow";
import { heldCreateGrant, holdCreateGrant, releaseCreateGrant } from "../lib/held-create-grant";
import { identityHeaders } from "../lib/session-identity";

import type { WorkspaceCreateLocal } from "./workspace-create";

export const WORKSPACE_CREATE_LOCAL: WorkspaceCreateLocal = {
  requestDeviceCode,
  heldCreateGrant,
  holdCreateGrant,
  releaseCreateGrant,
  creatingAge,
  identityHeaders,
};
