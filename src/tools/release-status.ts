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

export const schema = {
  name: "extension_release_status",
  description:
    "Read where a project stands on extension.dev, from the public registry (registry.extension.land). This is read-only: it dispatches nothing and promotes nothing. Pass include:'releases' for the release channels (channel to promoted build sha), recent builds, and a public build-page URL for each, which is how you find a valid sha for extension_release_promote, extension_submit or extension_publish. Pass include:'stores' for the per-store picture after an extension_submit (chrome, firefox, edge, safari): configured or not, the last credential health check, the last recorded submission, and the latest review status, read from stores/health.json, stores/status.json and stores/submissions.json; when your login covers the project it also reads the platform's own submission records and their store runs, so a submission whose run ended before recording anything still shows its run status, conclusion, run URL and whether any store step ran (a run that failed before any store step is recorded as failed, and no store received it). Those two are included by default. Pass include:'history' for the platform's release history: each release (browser and channel) with its build, version, rollout, promotion run and its 5 most recent events, plus whether a build is ready to promote, which only a token minted by a workspace owner may read and is otherwise reported as needing an owner. Pass releaseId (an id from history, such as chrome-stable) for that one release and up to 20 of its events. include:'runs' reads the newest release workflow runs (the last 7 days, or since a date up to 30 days back), which also needs a token minted by a workspace owner; include:'rollout' reads the Chrome staged rollout percentage and whether it can be raised; include:'cut' reads whether a release pull request opened now could build after merging. The stores section also reads each store's configuration from the platform when your login covers the project: whether it is enabled and configured, whether its credentials are set and the names of any missing ones (never a credential value), its listing URL and submission mode, plus up to 5 earlier submissions per store besides the latest; each submission the platform recorded carries its id, which extension_submit (action:'cancel') takes. This defaults to the logged-in project (extension_auth); pass workspace and project to read another. Private projects work when your stored login covers them. Registry state can lag the store dashboards by up to a polling interval.",
  inputSchema: {
    type: "object" as const,
    properties: {
      include: {
        type: "array",
        items: { type: "string", enum: ["releases", "stores", "history", "runs", "rollout", "cut"] },
        default: ["releases", "stores"],
        description:
          "Which sections to read: releases and stores by default; history adds the platform's release history; runs the newest release workflow runs; rollout the Chrome staged rollout; cut whether a release pull request could build after merging.",
      },
      since: {
        type: "string",
        description: "With runs, the earliest date to read from (ISO 8601, at most 30 days back; default 7 days).",
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

  const [releases, stores, history, release, runs, rollout, cut] = await Promise.all([
    include.includes("releases") ? readReleases(scope).then(parse) : null,
    include.includes("stores") ? readStores(scope).then(parse) : null,
    include.includes("history") ? readReleaseHistory(scope).then(parse) : null,
    releaseId ? readOneRelease({ ...scope, releaseId }).then(parse) : null,
    include.includes("runs") ? readPromotionRuns({ ...scope, since: args.since }).then(parse) : null,
    include.includes("rollout") ? readRollout(scope).then(parse) : null,
    include.includes("cut") ? readCutReadiness(scope).then(parse) : null,
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
    },
  });
}
