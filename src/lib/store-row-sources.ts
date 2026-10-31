// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isNewerOrSame, type PlatformSubmission, type StoreReview, type StoreStatusRead } from "./platform-submissions";
import { releaseChangeOfRow, type ReleaseTypeChange, type ReleaseTypeChangeRefused } from "./release-type-change";
import { AMO_SIGNED_STATUS, amoUnlistedSigning } from "./review-beside-submission";

import type { UpdateManifestView } from "./firefox-update-url";

export { releaseChangeOfRow, releaseChangeSentence, type ReleaseTypeChange, type ReleaseTypeChangeRefused } from "./release-type-change";

export interface SubmissionView {
  id?: string;
  version?: string;
  status?: string;
  storeUrl?: string;
  submittedAt?: string;
  channel?: string;
  buildSha?: string;
  storeSubmissionId?: string;
  failureReason?: string;
  supersededBy?: string;
  storeVersion?: { packaged: string; displayed: string; source: string; buildNumber?: number };
  storeCrxVersion?: string;
  storeReview?: StoreReview;
  statusRead?: StoreStatusRead;
  releaseType?: string;
  releaseTypeReadAt?: string;
  releaseTypeChanged?: ReleaseTypeChange;
  releaseTypeChangeRefused?: ReleaseTypeChangeRefused;
  updateManifest?: UpdateManifestView;
}


export const RELEASE_TYPE_MEANING: Record<string, string> = {
  AFTER_APPROVAL: "approval publishes it on the App Store at once, and an approval cannot be taken back from here",
  MANUAL: "approval holds it until you release it",
  SCHEDULED: "approval holds it until the date set in App Store Connect",
};

export const SAFARI_MANUAL_HOLD =
  "the review act sets it to manual release before sending it to App Review unless STORE.md states `- Release: after approval` under `## Safari`, and the record names the change in publish.releaseTypeChanged";

export function releaseTypeMeaning(type: string | undefined): string {
  const upper = String(type ?? "").toUpperCase();
  const meaning = RELEASE_TYPE_MEANING[upper];
  if (!meaning) return "";

  return upper === "AFTER_APPROVAL" ? `${meaning}; ${SAFARI_MANUAL_HOLD}` : meaning;
}

export const RELEASE_MODE_WORDS: Record<string, string> = {
  AFTER_APPROVAL: `is set to release automatically after approval: ${releaseTypeMeaning("AFTER_APPROVAL")}`,
  MANUAL: `is set to manual release: ${releaseTypeMeaning("MANUAL")}`,
  SCHEDULED: `is set to a scheduled release: ${releaseTypeMeaning("SCHEDULED")}`,
};

type ReleaseMode = Pick<SubmissionView, "releaseType" | "releaseTypeReadAt">;

function str(value: unknown): string | undefined {
  const text = String(value ?? "").trim();

  return text || undefined;
}

function knownMode(type: string | undefined, at: unknown): ReleaseMode | undefined {
  const upper = type?.toUpperCase();
  if (!upper || !RELEASE_MODE_WORDS[upper]) return undefined;

  const readAt = str(at);

  return { releaseType: upper, ...(readAt ? { releaseTypeReadAt: readAt } : {}) };
}

function modeOf(view: SubmissionView | undefined): ReleaseMode | undefined {
  if (!view?.releaseType) return undefined;

  return { releaseType: view.releaseType, ...(view.releaseTypeReadAt ? { releaseTypeReadAt: view.releaseTypeReadAt } : {}) };
}

function newerMode(a: ReleaseMode | undefined, b: ReleaseMode | undefined): ReleaseMode | undefined {
  if (!a || !b) return a ?? b;

  return Date.parse(String(b.releaseTypeReadAt ?? "")) > Date.parse(String(a.releaseTypeReadAt ?? "")) ? b : a;
}

export function releaseModeOfRow(appStoreRelease: unknown, publish: Record<string, unknown> | null): ReleaseMode | undefined {
  const polled = appStoreRelease && typeof appStoreRelease === "object" ? (appStoreRelease as Record<string, unknown>) : null;
  const polledMode = polled ? knownMode(str(polled.type), polled.readAt) : undefined;
  const actMode = publish ? knownMode(str(publish.releaseType), publish.at) : undefined;

  return newerMode(polledMode, actMode);
}

type SubmissionKey = Pick<SubmissionView, "buildSha" | "version" | "channel" | "storeVersion">;

function packagedVersion(entry: SubmissionKey): string {
  return entry.storeVersion?.packaged || entry.version || "";
}

export function sameSubmission(platform: SubmissionKey, registry: SubmissionKey): boolean {
  if (!platform.buildSha || !registry.buildSha || platform.buildSha !== registry.buildSha) return false;

  const packaged = packagedVersion(platform);
  if (packaged && packagedVersion(registry) && packaged !== packagedVersion(registry)) return false;

  const own = platform.storeVersion?.buildNumber;
  const recorded = registry.storeVersion?.buildNumber;
  if (own && recorded && own !== recorded) return false;

  return !platform.channel || !registry.channel || platform.channel === registry.channel;
}

export function platformSubmissionView(
  store: string,
  latest: PlatformSubmission,
  registry: SubmissionView | undefined,
): SubmissionView | null {
  const same = Boolean(registry && sameSubmission(latest, registry));
  if (!same && !isNewerOrSame(latest.submittedAt, registry?.submittedAt)) return null;

  const { run: _run, store: _store, appStoreRelease, ...rest } = latest;
  const publish = (rest.publish as Record<string, unknown> | undefined) ?? null;
  const mode = releaseModeOfRow(appStoreRelease, publish);
  const typed = { ...rest, ...(same ? newerMode(modeOf(registry), mode) : mode), ...releaseChangeOfRow(publish) };
  const fields = amoUnlistedSigning(store, typed.storeReview) ? { ...typed, status: AMO_SIGNED_STATUS } : typed;
  const own: SubmissionView = fields.storeVersion ? { ...fields, version: fields.storeVersion.packaged } : fields;

  return same ? { ...registry, ...own } : own;
}
