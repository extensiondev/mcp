// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

// The post-submit sibling of extension_deploy: deploy dispatches a store
// submission and this is the verb that answers "did it land, and was it
// approved?". Reads the project's public store state on
// registry.extension.land (stores/health.json + stores/status.json +
// stores/submissions.json), which needs no auth for public projects. The
// status document has two schema generations in the wild: v3 separates
// lastSubmission / lastOverride / lastPoll / reviews, while v2 poller
// documents carried their updates at the top level - both are normalized
// here so existing mirrors keep answering.

import {
  consoleProjectUrl,
  fetchRegistryJson,
  registryFileUrl,
  resolveProjectRef,
} from "../lib/registry";

const KNOWN_STORES = ["chrome", "firefox", "edge", "safari"] as const;

export const schema = {
  name: "extension_store_status",
  description:
    "Report the project's browser-store state after an extension_deploy submission: per store (chrome, firefox, edge, safari) whether it is configured, its latest credential health check, the last recorded submission (version, status, store URL, submitted-at), and the latest review status. Reads the project's public registry (registry.extension.land: stores/health.json, stores/status.json, stores/submissions.json) - read-only, dispatches nothing, no auth needed for public projects. Defaults to the logged-in project (extension_login); pass workspace + project to inspect another public project. Registry state can lag the store dashboards by up to a polling interval.",
  inputSchema: {
    type: "object" as const,
    properties: {
      workspace: {
        type: "string",
        description:
          "Workspace slug override (defaults to the stored login's workspace).",
      },
      project: {
        type: "string",
        description:
          "Project slug override (defaults to the stored login's project).",
      },
    },
    required: [],
  },
};

interface HealthRow {
  ok?: boolean;
  message?: string;
  checkedAt?: string;
}

interface SubmissionView {
  version?: string;
  status?: string;
  storeUrl?: string;
  submittedAt?: string;
  channel?: string;
  buildSha?: string;
  storeSubmissionId?: string;
  failureReason?: string;
}

interface ReviewView {
  status?: string;
  version?: string;
  buildId?: string;
  checkedAt?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

/** Map a submissions.json record (or status.json lastSubmission) to the
 * per-store view. The two writers use `buildId` vs `buildSha` and
 * `submittedAt` vs `timestamp`; both are accepted. */
function submissionView(row: Record<string, unknown>): SubmissionView {
  const view: SubmissionView = {};
  const version = str(row.version);
  const status = str(row.status);
  const storeUrl = str(row.storeUrl);
  const submittedAt = str(row.submittedAt) || str(row.timestamp);
  const channel = str(row.channel);
  const buildSha = str(row.buildSha) || str(row.buildId);
  const storeSubmissionId = str(row.storeSubmissionId);
  const failureReason = str(row.failureReason);
  if (version) view.version = version;
  if (status) view.status = status;
  if (storeUrl) view.storeUrl = storeUrl;
  if (submittedAt) view.submittedAt = submittedAt;
  if (channel) view.channel = channel;
  if (buildSha) view.buildSha = buildSha;
  if (storeSubmissionId) view.storeSubmissionId = storeSubmissionId;
  if (failureReason) view.failureReason = failureReason;
  return view;
}

/** Latest submissions.json record per store, newest submittedAt first. */
export function latestSubmissionsByStore(
  json: unknown,
): Record<string, SubmissionView> {
  const list = (json as { submissions?: unknown[] } | null)?.submissions;
  const out: Record<string, { at: number; view: SubmissionView }> = {};
  for (const raw of Array.isArray(list) ? list : []) {
    if (!isPlainObject(raw)) continue;
    const store = str(raw.store);
    if (!store) continue;
    const at = Date.parse(String(raw.submittedAt || raw.updatedAt || ""));
    const stamp = Number.isFinite(at) ? at : 0;
    if (!out[store] || stamp >= out[store].at) {
      out[store] = { at: stamp, view: submissionView(raw) };
    }
  }
  const flat: Record<string, SubmissionView> = {};
  for (const [store, entry] of Object.entries(out)) flat[store] = entry.view;
  return flat;
}

export interface NormalizedStoresStatus {
  lastSubmission?: Record<string, unknown>;
  lastOverride?: Record<string, unknown>;
  reviews: Record<string, ReviewView>;
  lastPollAt?: string;
}

/**
 * Accept any historical shape of stores/status.json. SchemaVersion 3 carries
 * lastSubmission / lastOverride / lastPoll / reviews as sections. Legacy v2
 * came in two flavors that used to clobber each other: the submit-path shape
 * (kind "stores_status", lastSubmission only) and the poller shape (kind
 * "store_status" with perStore/updates at the top level) whose updates seed
 * the reviews map here, mirroring the registry template's normalizer.
 */
export function normalizeStoresStatus(json: unknown): NormalizedStoresStatus {
  const base = isPlainObject(json) ? json : {};
  const out: NormalizedStoresStatus = { reviews: {} };

  if (isPlainObject(base.lastSubmission)) out.lastSubmission = base.lastSubmission;
  if (isPlainObject(base.lastOverride)) out.lastOverride = base.lastOverride;

  if (isPlainObject(base.reviews)) {
    for (const [store, raw] of Object.entries(base.reviews)) {
      if (!isPlainObject(raw)) continue;
      out.reviews[store] = {
        status: str(raw.status),
        version: str(raw.version),
        buildId: str(raw.buildId),
        checkedAt: str(raw.checkedAt),
      };
    }
  }

  const lastPoll = isPlainObject(base.lastPoll) ? base.lastPoll : null;
  const looksLikeLegacyPoll =
    !lastPoll && (base.kind === "store_status" || Array.isArray(base.updates));
  if (lastPoll) {
    out.lastPollAt = str(lastPoll.timestamp);
  } else if (looksLikeLegacyPoll) {
    out.lastPollAt = str(base.updatedAt);
    for (const raw of Array.isArray(base.updates) ? base.updates : []) {
      if (!isPlainObject(raw)) continue;
      const store = str(raw.store);
      if (!store || out.reviews[store]) continue;
      out.reviews[store] = {
        status: str(raw.status),
        version: str(raw.version),
        buildId: str(raw.buildId),
        checkedAt: str(base.updatedAt),
      };
    }
  }

  return out;
}

function fail(
  name: string,
  message: string,
  extra?: Record<string, unknown>,
): string {
  return JSON.stringify({ ok: false, error: { name, message }, ...(extra ?? {}) });
}

export async function handler(args: {
  workspace?: string;
  project?: string;
}): Promise<string> {
  const ref = resolveProjectRef(args);
  if (!ref) {
    return fail(
      "StoreStatusInputError",
      "No project to inspect. Run extension_login (the stored login names the project), or pass workspace + project explicitly.",
    );
  }

  const healthUrl = registryFileUrl(ref, "stores/health.json");
  const statusUrl = registryFileUrl(ref, "stores/status.json");
  const submissionsUrl = registryFileUrl(ref, "stores/submissions.json");
  const consoleStoresUrl = consoleProjectUrl(ref, "stores");

  const [healthRes, statusRes, submissionsRes] = await Promise.all([
    fetchRegistryJson(healthUrl),
    fetchRegistryJson(statusUrl),
    fetchRegistryJson(submissionsUrl),
  ]);

  if (!healthRes.ok && !statusRes.ok && !submissionsRes.ok) {
    return fail(
      "StoreStatusNotFound",
      `No store data on the registry for ${ref.workspace}/${ref.project} (${healthUrl} returned ${
        healthRes.status ?? "no response"
      }). The project may have no stores configured yet, be private (private registry data needs a share token), or the workspace/project slugs may be wrong. Configure stores at ${consoleStoresUrl}/new; the console Stores page is the authoritative view: ${consoleStoresUrl}`,
      {
        workspace: ref.workspace,
        project: ref.project,
        registryUrls: { health: healthUrl, status: statusUrl, submissions: submissionsUrl },
        consoleStoresUrl,
      },
    );
  }

  const healthStores: Record<string, HealthRow> | null = healthRes.ok
    ? isPlainObject((healthRes.json as { stores?: unknown })?.stores)
      ? ((healthRes.json as { stores: Record<string, HealthRow> }).stores ?? null)
      : null
    : null;
  const status = normalizeStoresStatus(statusRes.ok ? statusRes.json : null);
  const submissionsByStore = submissionsRes.ok
    ? latestSubmissionsByStore(submissionsRes.json)
    : {};

  // status.json's lastSubmission is a single record naming its store; it
  // backfills a store the (optional) submissions.json has no record for.
  const statusLastStore = str(status.lastSubmission?.store);
  if (statusLastStore && !submissionsByStore[statusLastStore] && status.lastSubmission) {
    submissionsByStore[statusLastStore] = submissionView(status.lastSubmission);
  }

  const stores = [
    ...KNOWN_STORES,
    ...Object.keys({ ...healthStores, ...submissionsByStore, ...status.reviews }).filter(
      (s) => !(KNOWN_STORES as readonly string[]).includes(s),
    ),
  ];

  const rows = stores.map((store) => {
    const healthRow = healthStores?.[store];
    // A store with a failing credential is still a CONFIGURED store - the
    // remedy is rotating its credential, not configuring it. `configured`
    // stays true there and `health.ok` carries the verdict.
    const configured: boolean | "unknown" = healthStores
      ? Boolean(healthRow)
      : "unknown";
    const row: Record<string, unknown> = { store, configured };
    if (healthRow) {
      row.health = {
        ok: healthRow.ok === true,
        checkedAt: str(healthRow.checkedAt),
        message: str(healthRow.message),
      };
    }
    const submission = submissionsByStore[store];
    if (submission && Object.keys(submission).length > 0) {
      row.lastSubmission = submission;
    }
    const review = status.reviews[store];
    if (review && Object.values(review).some(Boolean)) {
      row.review = review;
    }
    return row;
  });

  const summaryParts = rows.map((row) => {
    const store = String(row.store);
    const health = row.health as { ok: boolean; message?: string } | undefined;
    const submission = row.lastSubmission as SubmissionView | undefined;
    const review = row.review as ReviewView | undefined;
    let head: string;
    if (row.configured === "unknown") {
      head = `${store}: configuration unknown (stores/health.json is unreadable)`;
    } else if (row.configured === false) {
      head = `${store}: not configured (add it at ${consoleStoresUrl}/new)`;
    } else if (health && !health.ok) {
      head = `${store}: configured but its credentials FAILED the last health check (${
        health.message || "no reason recorded"
      }) - fix them at ${consoleStoresUrl}/${store}`;
    } else {
      head = `${store}: configured, credentials healthy`;
    }
    const tail: string[] = [];
    if (submission) {
      tail.push(
        `last submission${submission.version ? ` v${submission.version}` : ""} ${
          submission.status || "recorded"
        }${submission.submittedAt ? ` at ${submission.submittedAt}` : ""}${
          submission.failureReason ? ` (${submission.failureReason})` : ""
        }`,
      );
      if (submission.storeUrl) tail.push(`listing ${submission.storeUrl}`);
    } else if (row.configured === true) {
      tail.push("no submissions recorded");
    }
    if (review?.status) {
      tail.push(
        `review ${review.status}${review.checkedAt ? ` (checked ${review.checkedAt})` : ""}`,
      );
    }
    return tail.length > 0 ? `${head}; ${tail.join("; ")}` : head;
  });

  const result: Record<string, unknown> = {
    ok: true,
    workspace: ref.workspace,
    project: ref.project,
    stores: rows,
    ...(status.lastSubmission
      ? { lastSubmission: status.lastSubmission }
      : {}),
    ...(status.lastPollAt ? { lastPollAt: status.lastPollAt } : {}),
    registryUrls: {
      health: healthUrl,
      status: statusUrl,
      submissions: submissionsUrl,
    },
    consoleStoresUrl,
    message: `${summaryParts.join(". ")}. This is the registry's recorded state (submissions and the review poller write it); the store dashboards are authoritative and may be ahead of it.`,
  };
  if (!healthRes.ok) {
    result.healthUnavailable = `stores/health.json unreadable: ${healthRes.message}`;
  }
  if (!statusRes.ok) {
    result.statusUnavailable = `stores/status.json unreadable: ${statusRes.message}`;
  }
  if (!submissionsRes.ok && submissionsRes.status !== 404) {
    result.submissionsUnavailable = `stores/submissions.json unreadable: ${submissionsRes.message}`;
  }
  return JSON.stringify(result);
}
