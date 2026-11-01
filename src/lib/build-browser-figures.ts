// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text, type Row } from "./builds-list-row";

export interface BrowserFigures {
  browsers: unknown[] | null;
  notes: string[];
}

function rowName(row: Row): string {
  return text(row.name) || text(row.browser);
}

function sharedCommandNote(row: Row, duration: string): string {
  const from = text(row.buildCommandSharedFrom) || text(row.durationSharedFrom);
  const name = rowName(row);

  return from
    ? `${name}'s ${duration} is the time of the one build command that built ${from} and ${name} together.`
    : `${name}'s ${duration} is the time of one build command it shared with another browser.`;
}

export function browserFigures(build: Row, buildId: string): BrowserFigures {
  if (!Array.isArray(build.browsers)) return { browsers: null, notes: [] };

  const buildDuration = text(build.duration);
  const shared: string[] = [];
  const commandShared: string[] = [];
  const browsers = build.browsers.map((entry) => {
    if (!isRow(entry)) return entry;

    const duration = text(entry.duration);
    if (!duration || duration === "-") return entry;

    const scope = text(entry.durationScope);

    if (scope === "browser") {
      if (entry.durationShared === true) commandShared.push(sharedCommandNote(entry, duration));

      return entry;
    }

    if (scope !== "build" && duration !== buildDuration) return entry;

    shared.push(rowName(entry));

    return { ...entry, durationScope: "build" };
  });

  const notes: string[] = [];
  const rows = browsers.filter(isRow);

  if (shared.length) {
    const shown = text(rows.find((row) => row.durationScope === "build")?.duration) || buildDuration;
    notes.push(
      `Per-browser build time is not recorded for build ${buildId}: the duration on ${shared.join(", ")} (${shown}) is the whole build's, marked durationScope "build".`,
    );
  }

  notes.push(...commandShared);

  const sized = rows.filter((row) => text(row.size) && text(row.size) !== "-");
  const exact = sized.every((row) => typeof row.bytes === "number");
  const sizes = new Set(sized.map((row) => text(row.size)));

  if (sized.length > 1 && sizes.size === 1 && !exact) {
    notes.push(
      `Every browser's size reads ${[...sizes][0]}, rounded to 0.1 MB, and the platform sent no exact bytes, so packages that differ by less than that read the same; the download action answers each package's bytes.`,
    );
  }

  return { browsers, notes };
}
