// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";
import { fallbackConnectUrl } from "./store-connection";

import type { ProjectRef } from "./registry";

type Row = Record<string, unknown>;

export const AMO_API_KEY_PAGE = "https://addons.mozilla.org/developers/addon/api/key/";

const CREDENTIALS_CHECK = "store.credentials_present";

function checkOf(json: Row, id: string): Row | null {
  const checks = Array.isArray(json.checks) ? json.checks : [];

  return checks.filter(isRow).find((check) => text(check.id) === id) ?? null;
}

/* @invariant A MISSING AMO CREDENTIAL IS "NOT CONNECTED", NOT THREE FAILED
 * CHECKS. The platform answers a Firefox store with no saved secrets as three
 * blocking checks (store.enabled, store.config_present and
 * store.credentials_present) whose docs link says nothing about Firefox, and
 * on 2026-10-22 the maintainer had to learn from the agent which values to
 * paste where. The credentials check reads fail only when the platform
 * verified the secret names and found them absent, so that one fact is the
 * connection state; the two values are named by the console form's labels,
 * never by the platform's secret names.
 */
export function firefoxNotConnected(json: Row): boolean {
  const check = checkOf(json, CREDENTIALS_CHECK);

  return check !== null && text(check.status) === "fail";
}

export function firefoxConnectUrl(ref: ProjectRef | null, api?: string): string {
  return fallbackConnectUrl(ref, "firefox", api);
}

export function firefoxConnectSentences(connectUrl: string): string {
  return `Firefox AMO is not connected to this project yet. Mozilla issues the two values once at ${AMO_API_KEY_PAGE}: the JWT issuer and the JWT secret, as the console form labels them. Paste them, with the add-on id or its AMO dashboard address, into the Firefox store settings at ${connectUrl}; store publishing is turned on there or with extension_submit action:"configure-store" store:"firefox" storeSettings:{enabled:true} (one owner approval); then say preflight again. I upload to the unlisted channel unless the project saved a release channel, and sign it for self distribution.`;
}

const SOURCE_ARCHIVE_CHECK = "store.firefox_source_archive";

export const SOURCE_ARCHIVE_FIX = 'turn on Source archive with extension_submit action:"configure-store" store:"firefox" storeSettings:{sourceArchive:"repository"} (a plain call under your own token)';

export interface SourceArchiveRead {
  attached: boolean;
  setting: string;
}

export function sourceArchiveOf(json: Row): SourceArchiveRead | null {
  const check = checkOf(json, SOURCE_ARCHIVE_CHECK);
  if (!check) return null;

  const attached = text(check.status) === "pass";

  return { attached, setting: text(check.actual) || (attached ? "repository" : "none") };
}

export function sourceArchiveSentence(read: SourceArchiveRead, connectUrl: string): string {
  return read.attached
    ? "Firefox source archive: the platform will attach the source repository at the built commit to the upload for Mozilla's reviewers."
    : `Firefox source archive: no source archive is configured; Mozilla requires matching sources for a bundled build, and every platform build is bundled; ${SOURCE_ARCHIVE_FIX} or in the console's Firefox store settings at ${connectUrl}.`;
}

const SOURCE_ARCHIVE_SWITCH_SENTENCE =
  "The Firefox store settings also hold the Source archive switch, which Mozilla's review needs for a bundled build; every platform build is bundled, so the same configure-store call can carry sourceArchive:\"repository\".";

/* @invariant THE SOURCE ARCHIVE IS NAMED BEFORE THE STORE IS CONNECTED. The
 * platform's store.firefox_source_archive check appears only once the
 * Firefox store is connected, so on 2026-10-23 the owner met the setting
 * after the credentials and the switch, as a third trip to the same page.
 * A not-connected answer reads the check when www sends it and otherwise
 * names the switch in one sentence, so the trip to the settings page is one.
 */
export function firefoxSourceArchiveLine(json: Row, connectUrl: string): string {
  const read = sourceArchiveOf(json);

  return read ? sourceArchiveSentence(read, connectUrl) : SOURCE_ARCHIVE_SWITCH_SENTENCE;
}

export function firefoxSourceArchiveView(json: Row, connectUrl: string): Row {
  const read = sourceArchiveOf(json);

  return read ? { sourceArchive: { ...read, say: sourceArchiveSentence(read, connectUrl) } } : {};
}

export interface SourcesOutcome {
  attached: boolean | null;
  source: "platform-record" | "store-setting" | null;
  say: string;
}

/* @invariant THE SOURCES SENTENCE IS READ, NEVER GUESSED. The store run
 * packages the source repository only when the project's Firefox store
 * setting reads "repository" at run time and stops before the upload when
 * that fetch fails, so the setting the platform answered at submit time is a
 * fact about the upload; a `sourceArchive` field on the platform's own
 * submission record wins over it. With neither, the answer says the record
 * does not carry it and where the setting is read, instead of a verdict.
 */
export function firefoxSourcesOutcome(
  record: { sourceArchive?: string } | undefined,
  settingAtSubmit: string | undefined,
  connectUrl: string,
): SourcesOutcome {
  const recorded = text(record?.sourceArchive);
  const setting = recorded || text(settingAtSubmit);

  if (!setting) {
    return {
      attached: null,
      source: null,
      say: `Whether a source archive went with the Firefox upload is not in the platform's record; the Firefox store settings at ${connectUrl} say whether Source archive is on.`,
    };
  }

  const source = recorded ? "platform-record" : "store-setting";

  if (setting === "repository") {
    return {
      attached: true,
      source,
      say: recorded
        ? "Firefox: sources attached; the platform's record says the source repository at the built commit went with the upload."
        : "Firefox: sources attached; the Firefox store setting read at submit time attaches the source repository at the built commit to the upload.",
    };
  }

  return {
    attached: false,
    source,
    say: `Firefox: no sources attached; the upload went without a source archive, and Mozilla requires matching sources for a bundled build; ${SOURCE_ARCHIVE_FIX} or in the console's Firefox store settings at ${connectUrl} before the next submit.`,
  };
}
