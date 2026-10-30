// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { dispatchedPushSentence, docsOnlySentence, skippedPushSentence } from "./head-push";
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
  headPush?: { outcome: string; receivedAt: string };
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
  const subject = `HEAD ${short}`;

  if (builds.build && builds.why === null) return `${subject} has completed build ${builds.build} on the platform, which this read did not cover; call preflight again with buildSha: "${builds.build}"`;
  if (builds.why === "not-dispatched" && builds.headPush) return skippedPushSentence(builds.headPush, subject);
  if (builds.why === "dispatched-unlisted" && builds.headPush) return dispatchedPushSentence(builds.headPush, subject);
  if (builds.why === "no-record") return `${subject} has no platform build yet; push it so the package checks read it`;
  if (builds.why === "unreadable") return `${subject} is newer, and ${builds.missed}`;

  return `${subject} is pending on the platform: ${builds.missed}`;
}

function docsOnlySay(read: string[], newest: string, short: string, store: string): string {
  const subject = `HEAD ${short}`;

  if (read.some((id) => sameBuild(id, newest))) return `${store}: ${docsOnlySentence(subject, "the package checks read", newest)}.`;

  return `${store}: the package checks read build ${read.join(", ")}; ${subject} changes docs only and ${newest}, the newest build, carries the same package; call preflight again with buildSha: "${newest}".`;
}

export async function packageBuildView(projectPath: string, report: Row, store: string, shared: () => Promise<BuildIcons>): Promise<PackageBuildView | null> {
  const read = buildsReadByPackageChecks(report, store);
  if (!read.length || !projectPath) return null;

  const head = gitHead(projectPath);
  if (!head || read.some((id) => sameBuild(id, head))) return null;

  const short = head.slice(0, SHORT);
  const builds = await shared();
  const push = builds.headPush ? { headPush: { outcome: builds.headPush.outcome, receivedAt: builds.headPush.receivedAt } } : {};
  const say = builds.why === "docs-only" && builds.build ? docsOnlySay(read, builds.build, short, store) : `${store}: the package checks read build ${read.join(", ")}; ${headState(builds, short)}.`;

  return { read, head: short, ...push, say };
}

export function packageBuildViews(api: ProjectApi, projectPath: string, reports: Record<string, Row>, stores: string[]): Promise<Array<PackageBuildView | null>> {
  let builds: Promise<BuildIcons> | undefined;
  const shared = () => (builds ??= platformBuildIcons(api, projectPath, ""));

  return Promise.all(stores.map((store) => (reports[store] ? packageBuildView(projectPath, reports[store], store, shared) : Promise.resolve(null))));
}

export function packageBuildLine(views: Array<PackageBuildView | null>): string {
  return views
    .filter((view): view is PackageBuildView => view !== null)
    .map((view) => view.say)
    .join(" ");
}
