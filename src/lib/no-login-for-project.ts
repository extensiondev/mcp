// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { createdOnServer } from "./created-projects";
import { envelope } from "./envelope";
import { heldBatchForRef } from "./held-batches";
import { resolveApiBase } from "./login-flow";
import { pathIdentity } from "./path-project";
import { pendingCreate } from "./pending-creates";
import { LISTING_STORES, type ListingStore } from "./store-md-declarations";
import { linesNotFound } from "./store-md-fields";
import { readLocalListing } from "../tools/store-listing";

type Args = Record<string, unknown>;

export const NO_LOGIN_FOR_PROJECT_STATUS = "no-login-for-project";
export const NO_LOGIN_FOR_PROJECT_CODE = "E_NO_LOGIN_FOR_PROJECT";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function loginStep(ref: string): string {
  return `extension_auth (action: login, project: '${ref}')`;
}

function clockOf(iso: string): string {
  return `${iso.slice(11, 16)} UTC`;
}

interface NextStep {
  hint: string;
  value: Args;
}

/* @invariant A PATH THAT NAMES A PROJECT WITH NO LOGIN IS NOT AMBIGUOUS. On
 * 2026-10-30 a preflight on a directory whose project was still being
 * created answered project-mismatch and offered the logins of two other
 * projects, which invites a submit of the wrong one. The next step is read
 * from this machine's own records: a create waiting for the owner's approval
 * (its code and deadline), a create whose grant is held (resume it with its
 * deviceCode), a project this machine created (sign in to it), or neither
 * (create it, then sign in). No other project's login is ever offered.
 */
export function nextStepForUnloggedProject(ref: string, projectPath: string, api?: string): NextStep {
  const apiBase = resolveApiBase(api);
  const pending = pendingCreate(apiBase, ref);

  if (pending) {
    const approveAt = pending.verificationUriComplete || pending.verificationUri;

    return {
      hint: `A create of ${ref} is waiting for approval on this machine: approve it at ${approveAt} (code ${pending.userCode}; it expires at ${clockOf(pending.expiresAt)}), then call extension_project_create again with the deviceCode its first call answered and the same arguments. Once it answers created, sign in with ${loginStep(ref)} and call this again.`,
      value: { pendingCreate: { project: ref, userCode: pending.userCode, verificationUri: approveAt, expiresAt: pending.expiresAt } },
    };
  }

  const held = heldBatchForRef(apiBase, ref);

  if (held) {
    const until = new Date(held.grantExpiresAt * 1000).toISOString();

    return {
      hint: `extension_project_create for ${ref} holds a provisioning grant on this machine until ${until}: call it again with the same deviceCode and arguments to read the outcome (created, still creating, or refused), then sign in with ${loginStep(ref)} and call this again.`,
      value: { createGrantHeldUntil: until },
    };
  }

  if (createdOnServer(apiBase, ref)) {
    return {
      hint: `${ref} exists on this server (this machine created it) and only its login is missing: sign in with ${loginStep(ref)}, then call this again.`,
      value: { createdHere: true },
    };
  }

  const { owner, repo } = pathIdentity(projectPath);
  const repoSaid = owner && repo ? `, repo: '${owner}/${repo}'` : "";

  return {
    hint: `If ${ref} does not exist on extension.dev yet, create it first with extension_project_create (project: '${ref}'${repoSaid}), then sign in with ${loginStep(ref)}; if it already exists, only the login is missing and ${loginStep(ref)} alone is the step. Then call this again.`,
    value: {},
  };
}

function askedStores(args: Args): ListingStore[] {
  const named = Array.isArray(args.browsers) && args.browsers.length ? args.browsers : [text(args.store) || "chrome"];
  const stores = named.map((entry) => text(entry).toLowerCase()).filter((entry): entry is ListingStore => (LISTING_STORES as readonly string[]).includes(entry));

  return [...new Set(stores)];
}

function localStoreRead(projectPath: string, store: ListingStore): Args {
  const local = readLocalListing(projectPath, store);

  if ("problem" in local) return { storeMd: { missing: local.problem } };

  return {
    storeMd: {
      file: local.file,
      found: Object.keys(local.patch.listing),
      notFound: linesNotFound(local).map((miss) => ({ line: miss.line, section: miss.section })),
      ...(local.skipped.length ? { skipped: local.skipped } : {}),
    },
    icon: local.icon ?? { missing: local.iconMissing ?? "no icon found" },
  };
}

/* @invariant THE LOCAL HALF OF A PREFLIGHT NEEDS NO LOGIN. STORE.md lines and
 * the built icon are read from projectPath and answered beside the refusal,
 * and every store's readiness reads unknown until the project has a login.
 */
export function localPreflightHalf(name: string, args: Args, projectPath: string): Args {
  if (name !== "extension_submit" || text(args.action) !== "preflight") return {};

  const stores = askedStores(args);
  if (stores.length === 0) return {};

  return {
    local: Object.fromEntries(stores.map((store) => [store, localStoreRead(projectPath, store)])),
    stores: Object.fromEntries(stores.map((store) => [store, { readiness: "unknown", why: "the store half reads through the project's login, which this machine does not hold yet" }])),
  };
}

export function noLoginForProjectRefusal(args: {
  name: string;
  callArgs: Args;
  projectPath: string;
  named: string[];
  defaultLogin: string | null;
  api?: string;
}): string {
  const ref = args.named[0] ?? "";
  const next = nextStepForUnloggedProject(ref, args.projectPath, args.api);
  const local = localPreflightHalf(args.name, args.callArgs, args.projectPath);
  const localSaid = "local" in local ? " The local half of the preflight is in value.local (STORE.md lines and the built icon); each store's readiness reads unknown until the project has a login." : "";
  const defaultSaid = args.defaultLogin ? ` The default login here is ${args.defaultLogin}, and it was not used in its place.` : "";

  return envelope({
    ok: false,
    command: args.name,
    status: NO_LOGIN_FOR_PROJECT_STATUS,
    value: {
      projectPath: args.projectPath,
      named: args.named,
      ...next.value,
      ...(args.defaultLogin ? { defaultLogin: args.defaultLogin } : {}),
      ...local,
    },
    error: {
      code: NO_LOGIN_FOR_PROJECT_CODE,
      name: "NoLoginForProject",
      message: `projectPath ${args.projectPath} is the project ${args.named.join(" or ")}, and no login stored on this machine is for it, so nothing was read or sent.${defaultSaid}`,
    },
    hint: `${next.hint}${localSaid}`,
  });
}
