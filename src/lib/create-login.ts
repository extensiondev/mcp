// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { persistTokenResponse } from "./login-flow";

export interface CreateLogin {
  stored: boolean;
  project: string;
  expiresAt?: string;
  reason?: string;
  message?: string;
}

export interface CreateLoginRead {
  login: CreateLogin;
  sentence: string;
}

export function wantsCreateLogin(raw: unknown): boolean {
  return raw !== false && raw !== "false";
}

function loginCall(project: string): string {
  return `extension_auth (action: login, project: '${project}')`;
}

function oneMoreApproval(project: string, why: string): string {
  return `${why}, so one more approval is needed: ${loginCall(project)}.`;
}

export function readCreateLogin(args: {
  data: Record<string, unknown>;
  apiBase: string;
  project: string;
  login: boolean;
}): CreateLoginRead {
  const project = args.project;
  const token = String(args.data.token || "").trim();
  const issued = args.data.tokenIssued === true && token.length > 0;

  if (!args.login) {
    return {
      login: { stored: false, project, reason: "not-asked" },
      sentence: `No login was stored for ${project} (login: false)${issued ? ", and the token the platform answered was discarded" : ""}; ${loginCall(project)} mints one with its own approval.`,
    };
  }

  if (args.data.replayed === true) {
    return {
      login: { stored: false, project, reason: "replayed" },
      sentence: oneMoreApproval(project, "The platform read this create back from its record of the earlier request, and a replay carries no token"),
    };
  }

  if (!issued) {
    const reason = String(args.data.tokenCode || "").trim() || "NO_TOKEN_IN_RESPONSE";
    const message = String(args.data.tokenMessage || "").trim();

    return {
      login: { stored: false, project, reason, ...(message ? { message } : {}) },
      sentence: oneMoreApproval(project, `The platform answered no project token on this grant (${reason})`),
    };
  }

  try {
    const creds = persistTokenResponse({ apiBase: args.apiBase, project, data: args.data });
    const expiresAt = creds.expiresAt ? new Date(creds.expiresAt * 1000).toISOString() : undefined;

    return {
      login: { stored: true, project, ...(expiresAt ? { expiresAt } : {}) },
      sentence: `The same approval signed this machine in to ${project}: the token the platform minted with the create is stored as its login${expiresAt ? ` until ${expiresAt}` : ""}, so no extension_auth call is needed and token-scoped tools can use it now.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return {
      login: { stored: false, project, reason: "TOKEN_NOT_STORED", message },
      sentence: oneMoreApproval(project, `The platform minted a token with the create but it could not be stored on this machine and was discarded (${message})`),
    };
  }
}
