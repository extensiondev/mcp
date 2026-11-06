// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { openListingPushWarnings } from "../lib/safari-listing-push-read";
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
    "Read where a project stands on extension.dev: channels, builds, store submissions and reviews, history, rollout, listings. Read-only.",
  inputSchema: {
    type: "object" as const,
    properties: {
      include: {
        type: "array",
        items: { type: "string", enum: ["releases", "stores", "history", "runs", "rollout", "cut", "listing"] },
        default: ["releases", "stores"],
        description:
          "releases: channels, builds; stores: submissions, reviews; history, runs: owner only; rollout: Chrome; cut: would a release PR build; listing: listings, gaps.",
      },
      since: {
        type: "string",
        description: "runs: earliest ISO date, within 30 days.",
      },
      refresh: {
        type: "array",
        items: { type: "string", enum: ["chrome", "edge", "firefox", "safari"] },
        description:
          "stores: re-read these stores now (once per two minutes).",
      },
      waitSeconds: {
        type: "number",
        description:
          "refresh: wait 0 to 600 s for the check.",
      },
      submissionId: {
        type: "string",
        description:
          "stores: one submission by id or 8-character prefix.",
      },
      store: {
        type: "string",
        enum: ["chrome", "firefox", "edge", "safari"],
        description: "Only this store.",
      },
      releaseId: {
        type: "string",
        description: "One release, e.g. chrome-stable.",
      },
      workspace: {
        type: "string",
        description: "Workspace slug.",
      },
      project: {
        type: "string",
        description: "Project slug.",
      },
      projectPath: {
        type: "string",
        description:
          "Project root; picks its project.",
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
  projectPath?: string;
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
    include.includes("stores") ? readStores({ ...scope, refresh: args.refresh, submissionId: args.submissionId, waitSeconds: args.waitSeconds, store: args.store }).then(parse) : null,
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
    warnings: [
      ...openListingPushWarnings(stores),
      ...(partial
        ? [
            `Only part of the status could be read: ${failed
              .map(
                ([name, section]) =>
                  `${name} failed (${(section.error as { message?: string } | undefined)?.message ?? "no message"})`,
              )
              .join("; ")}. The sections that are present are complete; the failed ones are unknown, not empty.`,
          ]
        : []),
    ],
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
