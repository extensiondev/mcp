// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { mintedApproval, rememberMintedApproval, standingApprovalForAct } from "./approval-record";
import { dropHeldBatch, heldBatchForRef, loadHeldBatch, saveHeldBatch } from "./held-batches";
import { forgetPendingCreate, pendingCreate, rememberPendingCreate } from "./pending-creates";

import type { ApprovalState } from "./approval-state";

export const FILE_APPROVAL_STATE: ApprovalState = {
  mintedApproval: async (api, approvalId, now) => mintedApproval(api, approvalId, now),
  standingApprovalForAct: async (args) => standingApprovalForAct(args),
  rememberMintedApproval: async (args) => rememberMintedApproval(args),
  loadHeldBatch: async (apiBase, deviceCode) => loadHeldBatch(apiBase, deviceCode),
  heldBatchForRef: async (apiBase, ref) => heldBatchForRef(apiBase, ref),
  saveHeldBatch: async (apiBase, deviceCode, batch) => saveHeldBatch(apiBase, deviceCode, batch),
  dropHeldBatch: async (apiBase, deviceCode) => dropHeldBatch(apiBase, deviceCode),
  pendingCreate: async (apiBase, project) => pendingCreate(apiBase, project),
  rememberPendingCreate: async (apiBase, project, record) => rememberPendingCreate(apiBase, project, record),
  forgetPendingCreate: async (apiBase, project) => forgetPendingCreate(apiBase, project),
};
