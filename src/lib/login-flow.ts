// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { PROD_ORIGINS } from "@extension.dev/urls/origins";

import {
  writeCredentialBatch,
  writeCredentials,
  type StoredCredentials,
} from "./credentials";
import { tokenExpiry } from "./credentials";
import {
  readBatchCapability,
  sameProjectSet,
  type BatchCapability,
} from "./project-batch";
import { consoleBase, consoleProjectUrl } from "./registry";

const DEFAULT_API = PROD_ORIGINS.www;

export function tokenTtlNote(
  workspaceSlug?: string,
  projectSlug?: string,
): string {
  const tokensUrl =
    workspaceSlug && projectSlug
      ? consoleProjectUrl(
          { workspace: workspaceSlug, project: projectSlug },
          "settings/access-tokens",
        )
      : consoleBase();

  return `extension.dev CLI tokens live at most 7 days (server-enforced). CI pipelines must re-mint before expiry on the console's Access tokens page: ${tokensUrl}`;
}

type FetchImpl = typeof fetch;

export function resolveApiBase(api?: string): string {
  return String(
    api || process.env.EXTENSION_DEV_API_URL || DEFAULT_API,
  ).replace(/\/+$/, "");
}

function isExtensionDevHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");

  return host === "extension.dev" || host.endsWith(".extension.dev");
}

export function safeApiBase(
  raw: string,
  callerSupplied?: string,
): { ok: true; base: string } | { ok: false; message: string } {
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, message: `Invalid platform URL: ${raw}` };
  }

  const isLocalhost =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    return {
      ok: false,
      message: `Refusing to send the access token to ${raw}: use https (http is allowed only for localhost).`,
    };
  }

  /* @invariant
   * An operator may point this anywhere. A tool argument may not.
   *
   * Self-hosting is supported, so the platform URL cannot be pinned to
   * extension.dev outright: EXTENSION_DEV_API_URL and the CLI flag are set by
   * the person running the server and are trusted to name any https host. The
   * `api` tool argument is different in kind. A model can be talked into
   * supplying it by anything it reads, a README, an issue body, a template
   * description, and what travels here is a live project token that can
   * publish, list and revoke. A scheme check answers "is this encrypted", not
   * "is this us", and https is exactly what an attacker's host would offer.
   * Where the value came from is the only thing that separates the two, so
   * that is what this branches on.
   */
  const fromCaller = String(callerSupplied || "").trim();

  if (fromCaller && !isLocalhost && !isExtensionDevHost(parsed.hostname)) {
    return {
      ok: false,
      message: `Refusing to send the access token to ${raw}: an api argument may only name an extension.dev host or a local dev server. To use a self-hosted platform, set EXTENSION_DEV_API_URL where the server is launched instead of passing it per call.`,
    };
  }

  return { ok: true, base: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "") };
}

export interface LoginConfig {
  deviceCodeUrl: string;
  deviceTokenUrl: string;
  verificationUri: string;
  batch: BatchCapability | null;
}

function readJsonObject(text: string): { value: Record<string, unknown> } | { problem: string } {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { problem: "not a JSON object" };

    return { value: parsed as Record<string, unknown> };
  } catch (err) {
    return { problem: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchLoginConfig(
  apiBase: string,
  fetchImpl: FetchImpl = fetch,
): Promise<LoginConfig> {
  const res = await fetchImpl(`${apiBase}/api/cli/login/config`, {
    headers: { accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(
      `Could not fetch login config from ${apiBase} (${res.status}).`,
    );
  }

  /* @invariant AN UNREADABLE CONFIG IS NOT A PLATFORM THAT LACKS BATCH. A
     body that did not parse used to become {} and read as
     batch-unsupported, stated as a fact about the platform. */
  const read = readJsonObject(await res.text());

  if ("problem" in read) {
    throw new Error(
      `The login config at ${apiBase}/api/cli/login/config answered ${res.status} but could not be read (${read.problem}), so what this platform supports is unknown.`,
    );
  }

  const data = read.value;

  return {
    deviceCodeUrl: String(data.deviceCodeUrl || "/api/cli/device/code"),
    deviceTokenUrl: String(data.deviceTokenUrl || "/api/cli/device/token"),
    verificationUri: String(
      data.verificationUri || `${apiBase.replace(/\/+$/, "")}/device`,
    ),
    batch: readBatchCapability(data),
  };
}

export function persistTokenResponse(args: {
  apiBase: string;
  project: string;
  data: Record<string, unknown>;
}): StoredCredentials {
  const token = String(args.data.token || "").trim();
  if (!token) throw new Error("Login returned no token.");

  const workspaceSlug = String(args.data.workspaceSlug || "").trim();
  const projectSlug = String(args.data.projectSlug || "").trim();

  if (!workspaceSlug || !projectSlug) {
    throw new Error(
      `Login for ${args.project} returned a token without a workspace/project scope; nothing was stored. Run extension_auth (action: login) again.`,
    );
  }

  const [wantWorkspace = "", wantProject = ""] = args.project.split("/");
  const matches =
    workspaceSlug.toLowerCase() === wantWorkspace.toLowerCase() &&
    projectSlug.toLowerCase() === wantProject.toLowerCase();

  if (!matches) {
    throw new Error(
      `Login returned a token scoped to ${workspaceSlug}/${projectSlug}, not the requested ${args.project}; nothing was stored. Run extension_auth (action: login) again with the intended project.`,
    );
  }

  const creds: StoredCredentials = {
    version: 1,
    token,
    workspaceSlug,
    projectSlug,
    expiresAt: tokenExpiry(args.data.expiresAt),
    api: args.apiBase,
    provider: "extensiondev",
  };
  writeCredentials(creds);

  return creds;
}

/* @invariant A BATCH LOGIN STORES EXACTLY THE LIST IT ASKED FOR, OR NOTHING.
 * The platform answers one approval of a list with one token per listed
 * project. Every token is checked before any is written: each must carry a
 * token string and a workspace/project scope, and the set of scopes must be
 * the set of names this call sent, no fewer and no others. A token scoped to
 * a project this call never named is the one thing that must not be stored,
 * because every later tool would then act on that project as if someone had
 * signed in to it, so a response that carries one is refused whole rather
 * than trimmed to the names that match.
 */
export function persistBatchTokenResponse(args: {
  apiBase: string;
  projects: string[];
  data: Record<string, unknown>;
}): StoredCredentials[] {
  const raw = Array.isArray(args.data.tokens) ? args.data.tokens : null;

  if (!raw) {
    throw new Error(
      "The platform answered this batch login with a single token and no per-project list, so nothing was stored. It may predate batch login: sign in to each project with its own extension_auth (action: login, project) call.",
    );
  }

  const batch: StoredCredentials[] = raw.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const token = String(record.token || "").trim();
    const workspaceSlug = String(record.workspaceSlug || "").trim();
    const projectSlug = String(record.projectSlug || "").trim();

    if (!token || !workspaceSlug || !projectSlug) {
      throw new Error(
        "The batch login returned an entry without a token or a workspace/project scope; nothing was stored. Run extension_auth (action: login) again.",
      );
    }

    return {
      version: 1,
      token,
      workspaceSlug,
      projectSlug,
      expiresAt: tokenExpiry(record.expiresAt),
      api: args.apiBase,
      provider: "extensiondev",
    };
  });
  const returned = batch.map(
    (creds) => `${creds.workspaceSlug}/${creds.projectSlug}`,
  );

  if (
    new Set(returned.map((ref) => ref.toLowerCase())).size !== returned.length ||
    !sameProjectSet(args.projects, returned)
  ) {
    throw new Error(
      `The batch login returned tokens scoped to [${returned.join(", ")}], not the requested [${args.projects.join(", ")}]; nothing was stored. Run extension_auth (action: login) again with the intended projects.`,
    );
  }

  writeCredentialBatch(batch);

  return batch;
}
