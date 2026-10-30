// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { envelope, envelopeObject } from "../lib/envelope";
import { readReleases } from "./release-list";
import { readStores } from "./store-status";
import { readOneRelease, readReleaseHistory } from "./release-history";
import { readCutReadiness, readPromotionRuns, readRollout } from "./release-ship-reads";
import { readListing } from "./store-listing-read";

export const schema = {
  name: "extension_release_status",
  description:
    "Read where a project stands on extension.dev from the public registry (registry.extension.land): its release channels with each channel's audience and recent builds (include:'releases'), the per-store picture after an extension_submit (include:'stores', read from stores/health.json, stores/status.json and stores/submissions.json), the platform's release history (include:'history'), one release and its events (releaseId), the newest release workflow runs (include:'runs'), the Chrome staged rollout (include:'rollout'), whether a release pull request could build (include:'cut') and each store's saved extension.dev listing with what it lacks (include:'listing', one store with store). This is read-only: it dispatches and promotes nothing, and it is how you find a valid sha for extension_release_promote, extension_submit or extension_publish. Not for acting on a build or a submission: those are extension_release_promote and extension_submit. Not for whether a build link still opens: extension_shares (kind:'build-link') lists each link with its expiry, as the console Settings, Share links section does. Each channel on a public project carries channelUrl, the channel link that always opens that channel's newest build and never expires; on a public project, or a public channel, send testers the channel link; a build link from extension_publish opens one build and, on a private project, expires, and a private project gets value.channelUrlWithheld instead. It defaults to the logged-in project (extension_auth); pass workspace and project to read another, which works for a private project your stored login covers. Registry state can lag the store dashboards by a polling interval.",
  inputSchema: {
    type: "object" as const,
    properties: {
      include: {
        type: "array",
        items: { type: "string", enum: ["releases", "stores", "history", "runs", "rollout", "cut", "listing"] },
        default: ["releases", "stores"],
        description:
          "What to read. releases: the project's visibility as the platform records it (projectVisibility, public or private, with the registry's copy as the fallback), the channel to promoted build sha, each channel's audience (public or private) when the platform records it, recent builds, and a build page URL for each, which opens for anyone on a public project and only for workspace members on a private one; on a public project each channel also carries channelUrl per browser, <workspace>.extension.dev/<project>/channels/<browser>/<channel>. stores: for chrome, firefox, edge and safari, configured or not, the last credential health check, the last recorded submission and the latest review status; when your login covers the project it also reads the platform's own submission records and their store runs (a run that failed before any store step is recorded as failed, and no store received it), each store's configuration (enabled, credentials set and the names of any missing ones, never a value, listing URL, submission mode) and up to 5 earlier submissions per store, each with the id extension_submit (action:'cancel') takes; the safari row carries nextStep {kind, say, url} when a store check or the publish answer read Apple's state, watch while Apple reviews the version and release (extension_submit {action:'release', browsers:['safari']}) once Apple reads PENDING_DEVELOPER_RELEASE, and none for a word the platform inferred or someone recorded by hand. history: each release (browser and channel) with its build, version, rollout, promotion run and its 5 most recent events, plus whether a build is ready to promote; only a token minted by a workspace owner may read it. runs: the newest release workflow runs (the last 7 days, or since a date within the last 30 days), also owner-minted only. rollout: the Chrome staged rollout percentage and whether it can be raised. cut: whether a release pull request opened now could build after merging. listing: each store's saved listing (title, summary, description, categories, license, support email, homepage, privacy policy URL, per-store notes, icon and screenshot counts) and what it lacks; the four stores unless store names one. releases and stores are included by default.",
      },
      since: {
        type: "string",
        description: "With runs, the earliest date to read from (ISO 8601, within the last 30 days; default 7 days).",
      },
      refresh: {
        type: "array",
        items: { type: "string", enum: ["chrome", "edge", "firefox", "safari"] },
        description:
          "With stores, ask the platform to read these stores again now (one poll per project per two minutes, within the platform's GitHub budget), under the stored login and with no approval; value.refresh names what happened per store (dispatched, queued for the budget reset, or refused with the reason). The registry reflects the poll a minute or two later, so without waitSeconds read again before saying the state changed. Use it after a publish, or after the owner submitted in a store's own dashboard.",
      },
      waitSeconds: {
        type: "number",
        description:
          "With refresh, how long this call waits, 0 to 600 seconds, for the store check it dispatched to land in the registry, re-reading every 10 seconds, so a fresh store state takes one call: refresh:['safari'], waitSeconds:180. It answers once each dispatched store's state was read after the dispatch, or when the bound passes; value.refreshWait {landed, waitedSeconds, stores} says which, and landed false means the read is the state before the check. Without refresh, or when no check was dispatched, it reads once.",
      },
      submissionId: {
        type: "string",
        description:
          "With stores, read this one store submission by its id (or its first 8 characters) from every submission the platform records, not only the newest shown in submissionHistory; value.stores.submission answers its store, status, the store's own word and, for Firefox, the AMO channel. Use it to verify a record older than the history shows.",
      },
      store: {
        type: "string",
        enum: ["chrome", "firefox", "edge", "safari"],
        description: "With listing, read this one store's listing instead of all four.",
      },
      releaseId: {
        type: "string",
        description: "Read this one release and its events (an id from include:'history', such as chrome-stable). Alone, it reads only that release.",
      },
      workspace: {
        type: "string",
        description: "Workspace slug override (default: the stored login's).",
      },
      project: {
        type: "string",
        description: "Project slug override (default: the stored login's).",
      },
      api: API_BASE,
    },
    required: [],
  },
};

function parse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return envelopeObject({
      ok: false,
      command: "extension_release_status",
      status: "unavailable",
      error: { code: "E_PARSE", name: "ParseError", message: raw },
    }) as unknown as Record<string, unknown>;
  }
}

export async function handler(args: {
  include?: string[];
  since?: string;
  refresh?: string[];
  waitSeconds?: unknown;
  submissionId?: string;
  store?: string;
  releaseId?: string;
  workspace?: string;
  project?: string;
  api?: string;
}): Promise<string> {
  const releaseId = String(args.releaseId ?? "").trim();
  const include =
    Array.isArray(args.include) && args.include.length
      ? args.include
      : releaseId
        ? []
        : ["releases", "stores"];
  const scope = {
    workspace: args.workspace,
    project: args.project,
    api: args.api,
  };

  const [releases, stores, history, release, runs, rollout, cut, listing] = await Promise.all([
    include.includes("releases") ? readReleases(scope).then(parse) : null,
    include.includes("stores") ? readStores({ ...scope, refresh: args.refresh, submissionId: args.submissionId, waitSeconds: args.waitSeconds }).then(parse) : null,
    include.includes("history") ? readReleaseHistory(scope).then(parse) : null,
    releaseId ? readOneRelease({ ...scope, releaseId }).then(parse) : null,
    include.includes("runs") ? readPromotionRuns({ ...scope, since: args.since }).then(parse) : null,
    include.includes("rollout") ? readRollout(scope).then(parse) : null,
    include.includes("cut") ? readCutReadiness(scope).then(parse) : null,
    include.includes("listing") ? readListing({ ...scope, store: args.store }).then(parse) : null,
  ]);

  const named = (
    [
      ["releases", releases],
      ["stores", stores],
      ["history", history],
      ["release", release],
      ["runs", runs],
      ["rollout", rollout],
      ["cut", cut],
      ["listing", listing],
    ] as Array<[string, Record<string, unknown> | null]>
  ).filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[1]));
  const sections = named.map(([, section]) => section);

  const ok = sections.some((section) => section.ok === true);
  const failed = named.filter(([, section]) => section.ok !== true);
  const partial = ok && failed.length > 0;

  return envelope({
    ok,
    command: "extension_release_status",
    status: ok ? (partial ? "partial" : "read") : "unavailable",
    ...(partial
      ? {
          warnings: [
            `Only part of the status could be read: ${failed
              .map(
                ([name, section]) =>
                  `${name} failed (${(section.error as { message?: string } | undefined)?.message ?? "no message"})`,
              )
              .join("; ")}. The sections that are present are complete; the failed ones are unknown, not empty.`,
          ],
        }
      : {}),
    value: {
      ...(releases ? { releases } : {}),
      ...(stores ? { stores } : {}),
      ...(history ? { history } : {}),
      ...(release ? { release } : {}),
      ...(runs ? { runs } : {}),
      ...(rollout ? { rollout } : {}),
      ...(cut ? { cut } : {}),
      ...(listing ? { listing } : {}),
    },
  });
}
