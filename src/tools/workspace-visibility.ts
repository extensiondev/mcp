// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "../lib/envelope";
import { type ApprovalGateInput } from "../lib/approval-gate";
import { approvalVerdict } from "../lib/approval-policy";
import {
  OWNER_REQUIRED_CODE,
  openProjectApi,
  projectApiOpenFailure,
  projectApiReadFailure,
  tokenRefusal,
  type ProjectApi,
  type ProjectApiRefusal,
} from "../lib/project-api";
import { approvedSettingsWrite } from "../lib/settings-write";
import { trackUrl } from "../lib/track-url";

const COMMAND = "extension_workspace";
const ACTION = "set-visibility";
export const VISIBILITY_ACTION = "extension_project.visibility";

const PUBLIC_REASON = "A public project opens every build page and channel link it ever made to anyone with a link, which the ruling of 2026-10-23 keeps on the approve page: a workspace owner approves this exact change first, and the page shows it as the platform computed it.";
const PLATFORM_ASKED_REASON = "The platform asked a workspace owner to approve this exact change before it is saved; the approval page shows the change as the platform computed it.";

type Row = Record<string, unknown>;

interface VisibilityArgs {
  visibility?: string;
  approvalId?: string;
  project?: string;
  api?: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function badRequest(message: string, extra: Row = {}): string {
  return envelope({
    ok: false,
    command: COMMAND,
    status: "bad-request",
    value: { action: ACTION, ...extra },
    error: { code: "E_BAD_REQUEST", name: "VisibilityInputError", message },
  });
}

function refusal(sent: ProjectApiRefusal, api: ProjectApi, args: VisibilityArgs, visibility: string, page: string): string {
  const context = { workspace: api.ref.workspace, project: `${api.ref.workspace}/${api.ref.project}` };
  const value = { action: ACTION, visibility };

  if (sent.held || sent.status === 0 || tokenRefusal(sent.code, context) || sent.code === OWNER_REQUIRED_CODE) {
    return projectApiReadFailure(COMMAND, sent, { api: args.api, name: "Visibility", value, context });
  }

  const status = sent.status === 400 ? "bad-request" : sent.status === 404 ? "not-found" : sent.status === 401 || sent.status === 403 ? "refused" : "unavailable";

  return envelope({
    ok: false,
    command: COMMAND,
    status,
    value: { ...value, trackUrl: page },
    error: {
      code: status === "bad-request" ? "E_BAD_REQUEST" : status === "refused" ? "E_AUTH_DENIED" : "E_PLATFORM",
      name: `Visibility${status === "bad-request" ? "InputError" : "Refused"}`,
      ...(sent.code ? { platformCode: sent.code } : {}),
      message: sent.message,
    },
  });
}

/* @invariant A PRIVATE PROJECT IS A PLAIN WRITE AND A PUBLIC ONE IS A
 * PERSON'S, BY THE POLICY TABLE. The write goes out as one PUT under the
 * owner's own token; only visibility public reads "approval" in
 * approval-policy.ts, and then the platform refuses the PUT with the
 * request to mint, honored with the scope the platform named: the
 * visibility alone, so the owner reads exactly what opens. The answer
 * carries what the platform republished, because a visibility that the
 * record holds and the registry does not is the disagreement ledger 144
 * named, and it is said out loud here instead of read as done.
 */
export async function setVisibility(args: VisibilityArgs): Promise<string> {
  const visibility = text(args.visibility).toLowerCase();

  if (visibility !== "public" && visibility !== "private") {
    return badRequest(`set-visibility needs visibility: private or public${visibility ? `; got "${text(args.visibility)}"` : ""}. Nothing was changed.`);
  }

  const opened = await openProjectApi({ command: COMMAND, project: text(args.project) || undefined, api: args.api });

  if (!opened.ok) {
    return projectApiOpenFailure(COMMAND, opened, { api: args.api, name: "Visibility", value: { action: ACTION, visibility } });
  }

  const api = opened.api;
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const page = trackUrl("visibility", { workspace: api.ref.workspace, project: api.ref.project }, args.api);
  const opens = approvalVerdict(VISIBILITY_ACTION, { visibility }) === "approval";
  const stateRead = 'extension_release_status (include: ["releases"]) for projectVisibility';
  const scope = { visibility };
  const gate: ApprovalGateInput = {
    command: COMMAND,
    action: VISIBILITY_ACTION,
    scope,
    description: opens ? `Make ${project} public: every build page and channel link opens for anyone.` : `Make ${project} private.`,
    token: api.token,
    api: args.api,
    refusedStatus: "set-visibility-refused",
    reason: opens ? PUBLIC_REASON : PLATFORM_ASKED_REASON,
    stateRead,
    write: { visibility },
    refusalHint: (code) => (code === "NO_CHANGE" ? `The project is already ${visibility}; nothing needs changing.` : undefined),
  };

  const written = await approvedSettingsWrite({
    api,
    route: "visibility",
    body: { visibility },
    approvalId: text(args.approvalId),
    gate,
    mismatch: () =>
      envelope({
        ok: false,
        command: COMMAND,
        status: "set-visibility-refused",
        value: { action: ACTION, visibility, scope },
        error: {
          code: "E_PLATFORM",
          name: "VisibilityScopeMismatch",
          message: "The platform names this change differently from this server, so an approval of it could never be used. No approval was requested and nothing was changed.",
        },
      }),
    undone: "Nothing was changed by this call.",
    value: { action: ACTION, visibility },
    next: { used: `The call that used it may already have changed the visibility: read it with ${stateRead} first, and request a fresh approval only if the change is not there.` },
  });

  if (!written.ok) return written.out ?? refusal(written.sent, api, args, visibility, page);

  const recorded = text(written.json.visibility).toLowerCase() || visibility;
  const published = {
    indexPublished: written.json.indexPublished === true,
    metaRepublished: written.json.metaRepublished === true,
    channelsRewritten: written.json.channelsRewritten === true,
    exposurePublished: written.json.exposurePublished === true,
  };
  const lagging = Object.entries(published)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  const gateLine = written.verdict === "plain" && !text(args.approvalId) ? " This was a plain change under your own token; no approval page was involved." : "";
  const reach =
    recorded === "public"
      ? `${project} is public: every build page and channel link opens for anyone, and each channel's audience is public.`
      : `${project} is private: build pages and channel links open for workspace members and build links only, and each channel's audience is private.`;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "visibility-set",
    value: { action: ACTION, project, visibility: recorded, ...published, trackUrl: page },
    hint: `${reach}${gateLine} The Visibility section is ${page}.`,
    warnings: [
      lagging.length
        ? `The platform recorded the visibility but did not confirm ${lagging.join(", ")}, so the registry may answer the old visibility until the Visibility section is saved again in the console at ${page}.`
        : null,
    ],
  });
}
