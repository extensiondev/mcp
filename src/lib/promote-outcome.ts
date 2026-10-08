// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export interface PromoteNotarization {
  pending: string[];
  refused: { browsers: string[]; reason: string; upgradeUrl: string } | null;
}

export type PromoteOutcome =
  | {
      state: "promoted";
      queuedBrowsers: string[];
      notarization: PromoteNotarization;
    }
  | {
      state: "partial";
      queuedBrowsers: string[];
      failedBrowsers: string[];
      pendingMirrors: string[];
      githubReleaseFailed: boolean;
      githubReleaseAssetErrors: string[];
      notarization: PromoteNotarization;
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
  const notarized = asRecord(record.notarization);
  const refusal = asRecord(notarized?.refused);
  const refusedBrowsers = asStrings(refusal?.browsers) ?? [];
  const notarization: PromoteNotarization = {
    pending: asStrings(notarized?.pending) ?? [],
    refused:
      refusal && refusedBrowsers.length
        ? {
            browsers: refusedBrowsers,
            reason: String(refusal.reason ?? "").trim() || "unstated",
            upgradeUrl: String(refusal.upgradeUrl ?? "").trim(),
          }
        : null,
  };
  const pendingMirrors = [...pending, ...mirrorUnstated];

  if (
    failed.length === 0 &&
    pendingMirrors.length === 0 &&
    !releaseFailed &&
    assetErrors.length === 0
  ) {
    return { state: "promoted", queuedBrowsers: queued, notarization };
  }

  return {
    state: "partial",
    queuedBrowsers: queued,
    failedBrowsers: failed,
    pendingMirrors,
    githubReleaseFailed: releaseFailed,
    githubReleaseAssetErrors: assetErrors,
    notarization,
  };
}

export function notarizationNotes(notarization: PromoteNotarization): string[] {
  const notes: string[] = [];

  if (notarization.refused) {
    notes.push(
      `macOS notarization will NOT happen for ${notarization.refused.browsers.join(", ")}: the platform refused it (${notarization.refused.reason})${
        notarization.refused.upgradeUrl
          ? `; see ${notarization.refused.upgradeUrl}`
          : ""
      }. The release itself is unaffected.`,
    );
  }

  if (notarization.pending.length) {
    notes.push(
      `macOS notarization is still pending for ${notarization.pending.join(", ")}; the platform completes it after the release, and it is not part of this answer.`,
    );
  }

  return notes;
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

  return [...warnings, ...notarizationNotes(outcome.notarization)];
}
