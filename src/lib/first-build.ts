// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant
 * A FIRST BUILD IS SAID TO BE DISPATCHED ONLY WHEN THE PLATFORM SAID SO.
 *
 * Creating a project and dispatching its first build are two acts on the
 * platform, and the second one is withheld in ordinary cases: a repository
 * with no commits or no build workflow, a spent monthly allowance, a paused
 * dispatch, a testing workspace. The create answer is 200 in every one of
 * them, because the project does exist. This client used to print "its first
 * build was dispatched" on any 200, so a workspace at its build cap was told
 * a build was running. The answer now carries `initialBuild`, and this module
 * is the only reader of it: `dispatched` is true only on a literal true, a
 * literal false carries the platform's reason, and an answer without the
 * field is "unsaid", which is a third thing and never rounds up to yes.
 */
export type FirstBuild =
  | { state: "dispatched" }
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
    "the project's browser targets are not built on the workspace's plan",
  dispatch_failed: "the platform tried to dispatch it and could not",
  project_already_existed:
    "the project already existed, so this call started no build",
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
  if (dispatched === true) return { state: "dispatched" };

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
} {
  if (build.state === "dispatched") return { dispatched: true };

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
