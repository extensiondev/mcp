// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant
 * "PROMOTED" IS READ OFF THE ANSWER, NEVER OFF THE STATUS CODE.
 *
 * The platform answers a promote with 200 whenever at least one browser's
 * release workflow was dispatched, and says in the body what did not happen:
 * `failedBrowsers` for dispatches GitHub rejected, `mirrorSync.pending` for
 * registry files it could not write ("channels" means the channel pointer
 * does NOT name this build), `status: "degraded"` over both, and
 * `githubRelease.ok: false` for a release it could not publish. This client
 * used to print "promoted" on any 2xx, including a body it could not parse.
 * A promote cannot be undone in place and a blind retry dispatches the
 * release again, so the three outcomes are kept apart: whole, partial with
 * each missing piece named, and unconfirmed when the answer does not carry
 * the result at all.
 */
export type PromoteOutcome =
  | { state: "promoted"; queuedBrowsers: string[] }
  | {
      state: "partial";
      queuedBrowsers: string[];
      failedBrowsers: string[];
      pendingMirrors: string[];
      githubReleaseFailed: boolean;
      githubReleaseAssetErrors: string[];
      notarizationPending: string[];
    }
  | { state: "unconfirmed"; why: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

export function readPromoteOutcome(body: unknown): PromoteOutcome {
  const record = asRecord(body);
  if (!record) {
    return { state: "unconfirmed", why: "the answer was not a JSON object" };
  }
  if (record.ok !== true) {
    return { state: "unconfirmed", why: "the answer did not carry ok: true" };
  }
  const queued = asStrings(record.queuedBrowsers);
  if (!queued || queued.length === 0) {
    return {
      state: "unconfirmed",
      why: "the answer named no browser whose release was dispatched",
    };
  }
  const failed = asStrings(record.failedBrowsers) ?? [];
  const mirror = asRecord(record.mirrorSync);
  const pending = asStrings(mirror?.pending) ?? [];
  const mirrorUnstated =
    record.status !== "ok" && pending.length === 0 && mirror?.ok !== true
      ? ["unstated"]
      : [];
  const release = asRecord(record.githubRelease);
  const releaseFailed = release ? release.ok !== true : false;
  const assetErrors = asStrings(release?.assetErrors) ?? [];
  const notarization = asRecord(record.notarization);
  const notarizationPending =
    notarization && notarization.ok === false
      ? (asStrings(notarization.pending) ?? [])
      : [];
  const pendingMirrors = [...pending, ...mirrorUnstated];

  if (
    failed.length === 0 &&
    pendingMirrors.length === 0 &&
    !releaseFailed &&
    assetErrors.length === 0 &&
    notarizationPending.length === 0
  ) {
    return { state: "promoted", queuedBrowsers: queued };
  }
  return {
    state: "partial",
    queuedBrowsers: queued,
    failedBrowsers: failed,
    pendingMirrors,
    githubReleaseFailed: releaseFailed,
    githubReleaseAssetErrors: assetErrors,
    notarizationPending,
  };
}

export function partialPromoteWarnings(
  outcome: Extract<PromoteOutcome, { state: "partial" }>,
  channel: string,
): string[] {
  const warnings: string[] = [];
  if (outcome.failedBrowsers.length) {
    warnings.push(
      `The release was NOT dispatched for ${outcome.failedBrowsers.join(", ")}: the platform reports those dispatches failed. Promote again with browsers limited to ${outcome.failedBrowsers.join(", ")}; do not repeat ${outcome.queuedBrowsers.join(", ")}.`,
    );
  }
  if (outcome.pendingMirrors.includes("channels")) {
    warnings.push(
      `The ${channel} channel pointer was NOT moved: the platform could not write channels.json, so the channel still names its previous build although the release workflow was dispatched.`,
    );
  }
  const otherMirrors = outcome.pendingMirrors.filter(
    (name) => name !== "channels" && name !== "unstated",
  );
  if (otherMirrors.length) {
    warnings.push(
      `The platform could not write: ${otherMirrors.join(", ")}.`,
    );
  }
  if (outcome.pendingMirrors.includes("unstated")) {
    warnings.push(
      "The platform marked this promote as not fully applied without saying which part.",
    );
  }
  if (outcome.githubReleaseFailed) {
    warnings.push("The GitHub Release for this promote was not published.");
  }
  if (outcome.githubReleaseAssetErrors.length) {
    warnings.push(
      `The GitHub Release is missing assets: ${outcome.githubReleaseAssetErrors.join("; ")}.`,
    );
  }
  if (outcome.notarizationPending.length) {
    warnings.push(
      `Notarization did not start for ${outcome.notarizationPending.join(", ")}.`,
    );
  }
  return warnings;
}
