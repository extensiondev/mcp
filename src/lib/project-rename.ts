// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

type Row = Record<string, unknown>;

export interface ProjectRename {
  from: string;
  to: string;
  slug: string;
  changes: string[];
  unchanged: string[];
}

function sourceKind(general: Row): string {
  const source = general.displayNameSource;

  return source && typeof source === "object" && typeof (source as Row).kind === "string" ? String((source as Row).kind) : "";
}

export function projectRename(project: string, general: Row, change: Row): ProjectRename | null {
  if (typeof change.displayName !== "string") return null;

  const from = typeof general.displayName === "string" ? general.displayName : "";
  const to = change.displayName.trim();

  if (!to || to === from.trim()) return null;

  const followedBuild = sourceKind(general) === "build";

  return {
    from,
    to,
    slug: project,
    changes: [
      `the name extension.dev shows for ${project} in the console, the project list and its build pages`,
      followedBuild
        ? "the name is now yours: a later build's manifest name no longer replaces it"
        : "the name stays yours: a later build's manifest name does not replace it",
    ],
    unchanged: [
      `the slug ${project}, so every console URL, build, share, channel and live link, and every stored login keep working as they are`,
      "the GitHub repository and the extension's manifest name in the source, which is what browsers and stores show",
    ],
  };
}

export function renameHint(rename: ProjectRename): string {
  return `Renamed "${rename.from}" to "${rename.to}" on extension.dev. This changes ${rename.changes.join(", and ")}. It does not change ${rename.unchanged.join(", nor ")}.`;
}
