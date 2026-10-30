// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { text } from "./ship-act";
import { STORE_MD_FILENAME } from "./store-md";
import { HOST_BULLET_FORM } from "./store-md-bullets";
import { listOf, namesNotInBullets, uncoveredNamesIn } from "./store-md-host-justifications";

import type { RequirementRow } from "./store-requirements";
import type { PermissionJustification } from "./store-md-declarations";
import type { LocalListing } from "../tools/store-listing";

type Row = Record<string, unknown>;

export const CHROME_SYNC_CALL = 'extension_submit {action: "sync-listing", browsers: ["chrome"]}';

const JUSTIFICATIONS_HEADING = "`### Permissions justification`";

const NO_VISIBILITY_LINE = /the least public default[,;] (?:since )?STORE\.md has no `- Visibility:` line/;

const VISIBILITY_LABELS: Record<string, string> = { public: "Public", unlisted: "Unlisted", private: "Private (trusted testers)" };

const bulletsOf = (local: LocalListing): PermissionJustification[] =>
  (local.patch.listing.permissionJustifications ?? []) as PermissionJustification[];

const bulletCount = (n: number): string => (n === 1 ? "1 bullet" : `${n} bullets`);

/* @invariant A SENTENCE ABOUT STORE.md SAYS WHAT THE FILE HOLDS. The
 * platform's Chrome rows and checks read its listing record, filled by
 * sync-listing, and before the first sync they said "STORE.md has no
 * `### Permissions justification` bullets" and "STORE.md has no
 * `- Visibility:` line" of a file that carried both (ledger 303). This
 * server holds the file and reads it with the sync's own parser, so a claim
 * about the file is answered from the file: not synced yet, with the count
 * or the line the file carries and the call that writes it; a name the
 * platform says no bullet covers is checked against the file's bullets, and
 * one the file does not name either is asked for in the form the reader
 * takes (ledger 302). A file that carries nothing leaves the platform's
 * words as they are, since they are then true of the file as well.
 */
function visibilitySource(local: LocalListing, intent: string): string | null {
  const word = local.patch.listing.visibility;

  if (word) {
    const follows = VISIBILITY_LABELS[word] && VISIBILITY_LABELS[word] !== intent ? ` and the intent reads ${VISIBILITY_LABELS[word]}` : "";

    return `the least public default; ${STORE_MD_FILENAME} carries \`- Visibility: ${word}\`, not synced yet: run ${CHROME_SYNC_CALL}${follows}`;
  }

  const unread = local.unread.visibility;

  return unread ? `the least public default; the \`${unread.line}\` line in ${STORE_MD_FILENAME} ${unread.reason}` : null;
}

function withVisibilitySource(sentence: string, local: LocalListing): string | null {
  if (!NO_VISIBILITY_LINE.test(sentence)) return null;

  const intent = /intent is (\w+)/.exec(sentence)?.[1] ?? "";
  const source = visibilitySource(local, intent);

  return source ? sentence.replace(NO_VISIBILITY_LINE, source) : null;
}

function justificationsActual(actual: string, local: LocalListing): string | null {
  const bullets = bulletsOf(local);
  if (!bullets.length) return null;

  const carried = `${STORE_MD_FILENAME} carries ${bulletCount(bullets.length)} under ${JUSTIFICATIONS_HEADING}`;

  if (/STORE\.md has no `### Permissions justification` bullets/.test(actual)) {
    return `not synced yet (${carried}): run ${CHROME_SYNC_CALL}`;
  }

  const named = uncoveredNamesIn(actual);
  if (!named.length) return null;

  const missing = namesNotInBullets(named, bullets);

  if (!missing.length) {
    return `not synced yet (${carried}, naming ${listOf(named)}): run ${CHROME_SYNC_CALL}`;
  }

  return `${actual}; ${carried}, none naming ${listOf(missing)}: add ${HOST_BULLET_FORM}, then run ${CHROME_SYNC_CALL}`;
}

export function reconcileChromeRow(row: RequirementRow, local: LocalListing): RequirementRow {
  if (!row.actual) return row;

  if (row.id === "chrome.permission_justifications") {
    const actual = justificationsActual(row.actual, local);

    return actual ? { ...row, actual } : row;
  }

  if (row.id === "chrome.visibility") {
    const actual = withVisibilitySource(row.actual, local);

    return actual ? { ...row, actual } : row;
  }

  return row;
}

function hostCheckMessage(message: string, local: LocalListing): string | null {
  const named = uncoveredNamesIn(message);
  if (!named.length) return null;

  const bullets = bulletsOf(local);
  const missing = namesNotInBullets(named, bullets);

  if (!missing.length) {
    return `${listOf(named)} ${named.length > 1 ? "are" : "is"} named by a bullet under ${JUSTIFICATIONS_HEADING} in ${STORE_MD_FILENAME}, not yet in the listing record; sync-listing writes it.`;
  }

  const read = bullets.length ? ` (${bulletCount(bullets.length)} read)` : "";

  return `${message} ${STORE_MD_FILENAME} does not name ${listOf(missing)} yet${read}: write ${HOST_BULLET_FORM}, then run ${CHROME_SYNC_CALL}.`;
}

export function reconcileChromeCheck(check: Row, local: LocalListing): Row | null {
  const id = text(check.id);
  const message = text(check.message);
  if (!message) return null;

  if (id === "distribution.chrome_visibility") {
    const next = withVisibilitySource(message, local);

    return next ? { ...check, message: next } : null;
  }

  if (id === "listing.chrome_host_justifications" && text(check.status) === "warn") {
    const next = hostCheckMessage(message, local);

    return next ? { ...check, message: next } : null;
  }

  return null;
}
