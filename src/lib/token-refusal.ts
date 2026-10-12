// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type { ErrorCode } from "./envelope";

export interface TokenRefusal {
  status: "refused" | "auth-required";
  code: ErrorCode;
  name: string;
  hint: string;
}

/* @invariant A TOKEN REFUSAL NAMES THE NEXT STEP, NOT JUST THE STATUS. The
 * platform says which rule refused the token, and each rule has exactly one
 * way forward for an agent: another login, a login for another workspace or
 * project, a member who still belongs, or the console for a change a token
 * may never make. A code this table does not know falls through to the plain
 * status mapping below.
 */
export function tokenRefusal(
  platformCode: string,
  context: { workspace?: string; project?: string } = {},
): TokenRefusal | null {
  const workspace = context.workspace || "<workspace>";
  const project = context.project || `${workspace}/<project>`;
  const loginAgain = "Run extension_auth (action: \"login\") for the project again to mint a fresh login.";

  switch (platformCode) {
    case "TOKEN_WORKSPACE_MISMATCH":
      return {
        status: "refused",
        code: "E_AUTH_DENIED",
        name: "TokenWorkspaceMismatch",
        hint: `This login belongs to another workspace, and a login reads only its own workspace. Log in to a project of ${workspace} with extension_auth (action: "login", project: "${workspace}/<project>"), or to all of its projects with extension_auth (action: "login", workspace: "${workspace}", projects: "*"), then call again.`,
      };
    case "TOKEN_PROJECT_MISMATCH":
      return {
        status: "refused",
        code: "E_AUTH_DENIED",
        name: "TokenProjectMismatch",
        hint: `A project's own records are read only with that project's login. Log in to it with extension_auth (action: "login", project: "${project}") and pass it as project.`,
      };
    case "TOKEN_READ_ONLY":
      return {
        status: "refused",
        code: "E_AUTH_DENIED",
        name: "TokenReadOnly",
        hint: "A project login only reads workspace data. Make this change in the console.",
      };
    case "FORBIDDEN":
      return {
        status: "refused",
        code: "E_AUTH_DENIED",
        name: "MinterNotMember",
        hint: "The account that approved this login is no longer a member of the workspace, so every login it minted there stopped working. Sign in again as a current member with extension_auth (action: \"login\").",
      };
    case "TOKEN_ISSUER_UNKNOWN":
      return {
        status: "refused",
        code: "E_AUTH_DENIED",
        name: "TokenIssuerUnknown",
        hint: `The platform has no record of who approved this login, so it cannot act for anyone. ${loginAgain}`,
      };
    case "BAD_TOKEN":
    case "TOKEN_NOT_TRACKED":
    case "TOKEN_REVOKED":
      return {
        status: "auth-required",
        code: "E_AUTH_REQUIRED",
        name: platformCode === "TOKEN_REVOKED" ? "TokenRevoked" : "BadToken",
        hint: `This login is ${platformCode === "TOKEN_REVOKED" ? "revoked" : "not one the platform recognizes"}. ${loginAgain}`,
      };
    case "PROMOTE_THROUGH_CLI_ROUTE":
      return {
        status: "refused",
        code: "E_AUTH_DENIED",
        name: "ClosedToLogins",
        hint: "A login promotes only through the route that asks a person to approve the exact promote. Use extension_release_promote (buildId, channel), which takes that route.",
      };
    case "SUBMIT_THROUGH_CLI_ROUTE":
      return {
        status: "refused",
        code: "E_AUTH_DENIED",
        name: "ClosedToLogins",
        hint: "A login submits to a store only through the route that asks a workspace owner to approve the exact submission. Use extension_submit, which takes that route.",
      };
    case "RELEASE_DELETE_NEEDS_A_PERSON":
      return {
        status: "refused",
        code: "E_AUTH_DENIED",
        name: "ClosedToLogins",
        hint: "Deleting a release is a person's act: a member deletes it on the release's page in the console. No login may do it.",
      };
    case "SHARE_TOKEN":
      return {
        status: "auth-required",
        code: "E_AUTH_REQUIRED",
        name: "ShareToken",
        hint: "A share link's token opens that share only and is not a login. Sign in with extension_auth (action: \"login\").",
      };
    default:
      return null;
  }
}
