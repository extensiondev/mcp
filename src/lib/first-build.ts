// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export type FirstBuild =
  | { state: "dispatched"; buildUrl?: string }
  | { state: "withheld"; reason: string }
  | { state: "unsaid" };

const WITHHELD_BECAUSE: Record<string, string> = {
  no_build_workflow: "the project's repository has no build workflow",
  no_commits: "the source repository has no commits yet",
  unreadable_commit:
    "the platform could not read the source repository's head commit",
  missing_repository: "the platform could not name the source repository",
  dispatch_paused: "build dispatch is paused on the platform",
  testing_workspace:
    "the workspace is a testing workspace, which gets no builds",
  allowance_exhausted:
    "the workspace has used its build allowance for the month",
  target_not_allowed:
    "the project's browser targets are outside the workspace's build allowance",
  dispatch_failed: "the platform tried to dispatch it and could not",
  project_already_existed:
    "the project already existed, so this call started no build",
  already_dispatched:
    "the archive is the same tree the project already built, so the build it has stands",
};

export function readFirstBuild(body: unknown): FirstBuild {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  const fact = record?.initialBuild;

  if (!fact || typeof fact !== "object" || Array.isArray(fact)) {
    return { state: "unsaid" };
  }

  const dispatched = (fact as Record<string, unknown>).dispatched;

  if (dispatched === true) {
    const buildUrl = String((fact as Record<string, unknown>).buildUrl ?? "").trim();

    return buildUrl ? { state: "dispatched", buildUrl } : { state: "dispatched" };
  }

  if (dispatched === false) {
    const reason = String((fact as Record<string, unknown>).reason ?? "").trim();

    return { state: "withheld", reason: reason || "unstated" };
  }

  return { state: "unsaid" };
}

export function withheldBecause(reason: string): string {
  return (
    WITHHELD_BECAUSE[reason] ??
    (reason === "unstated"
      ? "the platform gave no reason"
      : `the platform's reason is ${reason}`)
  );
}

export function firstBuildValue(build: FirstBuild): {
  dispatched: boolean | null;
  reason?: string;
  buildUrl?: string;
} {
  if (build.state === "dispatched") {
    return build.buildUrl ? { dispatched: true, buildUrl: build.buildUrl } : { dispatched: true };
  }

  if (build.state === "withheld") {
    return { dispatched: false, reason: build.reason };
  }

  return { dispatched: null };
}

export function firstBuildSentence(
  build: FirstBuild,
  buildsPageUrl: string,
): string {
  if (build.state === "dispatched") return "Its first build was dispatched.";

  if (build.state === "withheld") {
    return `No first build was dispatched: ${withheldBecause(build.reason)}. The project exists without a build; start one from ${buildsPageUrl} once that is resolved.`;
  }

  return `The platform's answer did not say whether a first build was dispatched, so none is claimed here; ${buildsPageUrl} shows whether one is running.`;
}

export function reseedBuildSentence(
  build: FirstBuild,
  ref: string,
  buildsPageUrl: string,
): string {
  if (build.state === "dispatched") {
    return `Its build was dispatched${build.buildUrl ? `; ${build.buildUrl} tracks it` : ""}.`;
  }

  if (build.state === "withheld" && build.reason === "already_dispatched") {
    return `No new build was dispatched: ${withheldBecause(build.reason)}. extension_builds (action: list, project: '${ref}') names that build and ${buildsPageUrl} shows it; there is nothing to upload again.`;
  }

  if (build.state === "withheld") {
    return `No build was dispatched: ${withheldBecause(build.reason)}. The project holds the new tree without a build of it; extension_builds (action: rebuild, project: '${ref}') builds the stored tree once that is resolved.`;
  }

  return `The platform's answer did not say whether a build was dispatched, so none is claimed here; ${buildsPageUrl} shows whether one is running.`;
}
