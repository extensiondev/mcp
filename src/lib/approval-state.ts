// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export interface MintedApproval {
  approvalId: string;
  workspace: string;
  project: string;
  projectId?: string;
  loginId?: string;
  action: string;
  fingerprint: string;
  approvalUrl: string;
  mintedAt: string;
  expiresAt: string;
  description?: string;
  replaces?: string[];
  replacedBy?: string;
}

export interface RememberApprovalArgs {
  api?: string;
  token: string;
  projectId?: string;
  approvalId: string;
  action: string;
  fingerprint: string;
  approvalUrl: string;
  expiresAt?: string;
  description?: string;
  answeredFor?: string;
  now?: number;
}

export interface StandingApprovalArgs {
  api?: string;
  token: string;
  action: string;
  fingerprint: string;
  now?: number;
}

export interface HeldBatch<Row> {
  workspace: string;
  refs: string[];
  grant: string;
  grantExpiresAt: number;
  rows: Row[];
  creatingSince?: number;
  server?: string;
}

export interface PendingCreate {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: string;
}

export interface ApprovalState {
  mintedApproval(api: string | undefined, approvalId: string, now?: number): Promise<MintedApproval | null>;
  standingApprovalForAct(args: StandingApprovalArgs): Promise<MintedApproval | null>;
  rememberMintedApproval(args: RememberApprovalArgs): Promise<MintedApproval | null>;
  loadHeldBatch<Row>(apiBase: string, deviceCode: string): Promise<HeldBatch<Row> | null>;
  heldBatchForRef(apiBase: string, ref: string): Promise<HeldBatch<unknown> | null>;
  saveHeldBatch<Row>(apiBase: string, deviceCode: string, batch: HeldBatch<Row>): Promise<boolean>;
  dropHeldBatch(apiBase: string, deviceCode: string): Promise<void>;
  pendingCreate(apiBase: string, project: string): Promise<PendingCreate | null>;
  rememberPendingCreate(apiBase: string, project: string, record: PendingCreate): Promise<boolean>;
  forgetPendingCreate(apiBase: string, project: string): Promise<void>;
}
