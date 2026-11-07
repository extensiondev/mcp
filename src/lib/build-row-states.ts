// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { buildState, channelsOf, isActiveState, isRow, text, type Row } from "./builds-list-row";

const SIGNED_AT_SUBMIT = new Set(["safari"]);

export interface UnrecordedRow {
  name: string;
  recorded: false;
  reason: string;
  integrity?: Row;
  payloadBuilt?: true;
  signedAtSubmit?: true;
  submitReady?: true;
}

function storeName(browser: string): string {
  return `${browser.charAt(0).toUpperCase()}${browser.slice(1)}`;
}

export function rowNameOf(row: unknown): string {
  return isRow(row) ? text(row.name) || text(row.browser) : text(row);
}

export function runningBrowsers(rows: unknown[], buildUnfinished: boolean, inScope: (name: string) => boolean): Array<{ name: string; status: string }> {
  if (buildUnfinished) return [];

  return rows
    .filter(isRow)
    .map((row) => ({ name: rowNameOf(row), status: text(row.status) }))
    .filter((row) => row.name && inScope(row.name) && isActiveState(buildState(row.status)));
}

export function runningReason(status: string): string {
  return `it is still running (its row reads ${status}); its artifacts and integrity arrive when it finishes`;
}

export function unrecordedRow(browser: string, integrity: Row | null): UnrecordedRow {
  const base = `the platform's record of this build has no ${browser} row, so no build status is recorded for it`;

  if (!integrity) return { name: browser, recorded: false, reason: `${base}, and no integrity result could be read for its package (see unchecked)` };

  if (integrity.ok !== true) {
    return { name: browser, recorded: false, reason: `${base}, and its package failed integrity checks (see integrity.${browser}.failed)`, integrity };
  }

  if (SIGNED_AT_SUBMIT.has(browser.toLowerCase())) {
    const store = storeName(browser);

    return {
      name: browser,
      recorded: false,
      reason: `${base}, while its payload is built and passed its integrity checks; ${store} is signed at submit, not in this build, so a ${store} submit can go ahead with this build`,
      integrity,
      payloadBuilt: true,
      signedAtSubmit: true,
      submitReady: true,
    };
  }

  return { name: browser, recorded: false, reason: `${base}, while its package is built and passed its integrity checks`, integrity, payloadBuilt: true };
}

export function unrecordedClause(rows: UnrecordedRow[]): string | null {
  const built = rows.filter((row) => row.payloadBuilt);
  if (!built.length) return null;

  return built
    .map((row) =>
      row.signedAtSubmit
        ? `${row.name} is not recorded in the build record: its payload is built and passed its integrity checks, and ${storeName(row.name)} is signed at submit, so a ${storeName(row.name)} submit can go ahead (see build.browsers)`
        : `${row.name} is not recorded in the build record, so it has no build status, while its package passed its integrity checks (see build.browsers)`,
    )
    .join("; ");
}

export function runningClause(rows: Array<{ name: string; status: string }>): string | null {
  if (!rows.length) return null;

  return rows.map((row) => `${row.name} is still running (${row.status}), so its integrity is not checked yet`).join("; ");
}

export function envChannelOf(record: Row, listItem: Row | null): Row {
  const out: Row = {};
  const env = text(record.buildEnv) || text(record.env) || text(listItem?.buildEnv) || text(listItem?.env);
  const pins = channelsOf(record) ?? channelsOf(listItem);
  if (env) out.env = env;
  if (pins) out.channels = pins;

  return out;
}

export function listItemFor(json: unknown, buildId: string): Row | null {
  const items = isRow(json) && Array.isArray(json.items) ? json.items.filter(isRow) : [];
  const id = buildId.toLowerCase();

  return (
    items.find((item) => {
      const ids = [item.buildId, item.shortSha, item.id, item.commit].map((v) => text(v).toLowerCase()).filter((v) => v.length >= 7);

      return ids.some((v) => v === id || v.startsWith(id) || id.startsWith(v));
    }) ?? null
  );
}
