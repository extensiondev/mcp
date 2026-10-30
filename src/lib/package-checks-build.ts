// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators


import { isRow, text } from "./ship-act";
import { gitHead, platformBuildIcons } from "./store-listing-icon";

import type { ProjectApi } from "./project-api";
import type { BuildIcons } from "./store-listing-icon";

type Row = Record<string, unknown>;

const BUILD_IN_MESSAGE = /\bof build ([0-9a-f]{7,40})\b/g;
const SHORT = 7;

export interface PackageBuildView {
  read: string[];
  head: string;
  say: string;
}

export function buildsReadByPackageChecks(report: Row, store: string): string[] {
  const block = report[`${store}Preflight`];
  const rows = [...(Array.isArray(report.checks) ? report.checks : []), ...(isRow(block) && Array.isArray(block.checks) ? block.checks : [])].filter(isRow);
  const read = new Set<string>();

  for (const row of rows) {
    for (const match of text(row.message).matchAll(BUILD_IN_MESSAGE)) read.add(match[1]!.toLowerCase());
  }

  return [...read];
}

function sameBuild(id: string, head: string): boolean {
  return head.startsWith(id) || id.startsWith(head.slice(0, SHORT));
}

function headState(builds: BuildIcons, short: string): string {
  if (builds.build) return `HEAD ${short} has completed build ${builds.build} on the platform, which this read did not cover; call preflight again with buildSha: "${builds.build}"`;

  const missed = builds.missed ?? "";

  if (/has no platform build/.test(missed)) return `HEAD ${short} has no platform build yet; push it so the package checks read it`;
  if (/could not be read/.test(missed)) return `HEAD ${short} is newer, and ${missed}`;

  return `HEAD ${short} is pending on the platform: ${missed}`;
}

export async function packageBuildView(api: ProjectApi, projectPath: string, report: Row, store: string): Promise<PackageBuildView | null> {
  const read = buildsReadByPackageChecks(report, store);
  if (!read.length || !projectPath) return null;

  const head = gitHead(projectPath);
  if (!head || read.some((id) => sameBuild(id, head))) return null;

  const short = head.slice(0, SHORT);
  const builds = await platformBuildIcons(api, projectPath, "");

  return { read, head: short, say: `${store}: the package checks read build ${read.join(", ")}; ${headState(builds, short)}.` };
}

export function packageBuildLine(views: Array<PackageBuildView | null>): string {
  return views
    .filter((view): view is PackageBuildView => view !== null)
    .map((view) => view.say)
    .join(" ");
}
