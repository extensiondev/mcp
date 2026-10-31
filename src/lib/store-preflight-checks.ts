// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators


import { isRow, text } from "./ship-act";
import { releaseTypeMeaning } from "./store-row-sources";

type Row = Record<string, unknown>;

const ROW_KEYS = ["label", "severity", "status", "expected", "actual", "message"];

function checkRow(row: Row): Row {
  const out: Row = { id: text(row.id) };

  for (const key of ROW_KEYS) {
    if (text(row[key])) out[key] = text(row[key]);
  }

  if (!out.label) out.label = out.id;
  if (!out.status) out.status = "fail";

  const docs = text(row.docsUrl) || text(row.docs);
  if (docs) out.docsUrl = docs;

  if (!out.message && !out.actual) out.actual = `the platform's store preflight named it with no message and no actual (POST stores/<store>/submissions/preflight)`;

  return out;
}

function unexplained(store: string, id: string, list: string): Row {
  return {
    id,
    label: id,
    status: "fail",
    actual: `the platform's store preflight named it without a reason: POST stores/${store}/submissions/preflight listed it in ${store}Preflight.${list} with no row of that id in ${store}Preflight.checks`,
    expected: `a row in ${store}Preflight.checks with the rule's label, expected, actual and what to do`,
  };
}

export function storePreflightChecks(block: Row, store: string, blocking: string[], warnings: string[]): Row[] {
  const rows = (Array.isArray(block.checks) ? block.checks : []).filter(isRow);
  const byId = new Map(rows.map((row) => [text(row.id), row]));
  const named = [...blocking.map((id) => [id, "blocking"] as const), ...warnings.filter((id) => !blocking.includes(id)).map((id) => [id, "warnings"] as const)];

  return named.map(([id, list]) => {
    const row = byId.get(id);

    return row ? checkRow(row) : unexplained(store, id, list);
  });
}

export function releaseReadView(release: Row): Row {
  const type = text(release.type);
  const meaning = text(release.meaning) || releaseTypeMeaning(type);

  return {
    type,
    ...(text(release.readAt) ? { readAt: text(release.readAt) } : {}),
    ...(meaning ? { meaning } : {}),
    say: `App Store Connect last read the version as ${type}${text(release.readAt) ? ` (${text(release.readAt)})` : ""}: ${meaning || "a release type this server does not know"}.`,
  };
}
