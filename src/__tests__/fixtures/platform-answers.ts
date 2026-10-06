/* @invariant THESE ARE THE PLATFORM'S REAL ANSWERS, KEY FOR KEY. Each builder
 * returns the body the named www handler sends today, so a test that wants a
 * success feeds the client what production feeds it, and a test that wants a
 * degraded or shapeless answer has to say which key it changed. A bare
 * `{ ok: true }` is not an answer the platform gives, and tests that fed one
 * are how "any 2xx is success" went unseen. When a handler's body changes,
 * this file changes with it.
 */

type Body = Record<string, unknown>;

/* @invariant www: src/app/api/projects/[projectId]/releases/releases-route.create.ts,
 * the 200 at the end of the create handler, reached through
 * /api/cli/release/promote. All browsers failing is a 500, never this body. */
export function promoteAnswer(overrides: Body = {}): Body {
  return {
    ok: true,
    status: "ok",
    mirrorSync: { ok: true, pending: [] },
    buildId: "abc1234",
    sourceChannel: "",
    targetChannel: "beta",
    queuedBrowsers: ["chrome"],
    failedBrowsers: [],
    dispatchedAt: "2026-10-05T12:00:00.000Z",
    promotions: [
      { browser: "chrome", dispatchId: "d-1", correlation: "run-name" },
    ],
    ...overrides,
  };
}

/* @invariant www: src/app/api/clone/core/create-project-from-clone/seed-and-build.ts,
 * the one-body 200 of a freshly created project, reached through
 * /api/cli/projects/create. The MCP lane's success extras add the token keys. */
export function projectCreatedAnswer(overrides: Body = {}): Body {
  return {
    success: true,
    message: "Repository created successfully",
    projectId: "prj_new",
    projectSlug: "ghost-app",
    workspaceSlug: "acme",
    idempotencyKey: "idem-1",
    initialBuild: { dispatched: true },
    ...overrides,
  };
}

/* @invariant www: src/app/api/cli/stores/submit/route.ts, the 200 of a real submission
 * (dryRun false): one row per store dispatched, in the order asked, each
 * recorded as pending. The stores are dispatched one at a time, so a failure
 * mid-list is an error answer after earlier stores were already dispatched. */
export function submitAnswer(
  stores: string[] = ["chrome"],
  overrides: Body = {},
): Body {
  return {
    ok: true,
    projectId: "prj_1",
    buildId: "abc1234",
    channel: "stable",
    submissions: stores.map((store, index) => ({
      id: `sub-${index + 1}`,
      store,
      channel: "stable",
      buildId: "abc1234",
      version: "abc1234",
      status: "pending",
      submittedAt: "2026-10-05T12:00:00.000Z",
      workflowRunId: 1000 + index,
      workflowRunUrl: `https://github.com/extensiondev/mirror/actions/runs/${1000 + index}`,
      runCorrelation: "run-name",
      origin: "mcp",
    })),
    origin: "mcp",
    ...overrides,
  };
}

/* @invariant www: src/app/api/cli/publish/route.ts, the 200 of a private project: the
 * share URL, the served build (null fields when the project has no successful
 * build or the index could not be read), the token-bearing preview commands
 * and the expiry. A public project answers the same keys with no expiry and
 * token-less commands. */
export function publishAnswer(overrides: Body = {}): Body {
  return {
    shareUrl: "https://preview.extension.dev/?preview=gen_0123456789abcdef0123456789abcdef",
    visibility: "private",
    buildSha: "abc1234",
    version: "1.2.0",
    builtAt: "2026-10-05T11:00:00.000Z",
    previewCommands: {
      chrome: "npx extension preview https://registry.extension.land/acme/widget/_extension-dev/builds/abc1234/chrome.zip?token=t",
    },
    expiresAt: "2026-10-06T12:00:00.000Z",
    ...overrides,
  };
}

/* @invariant www: src/app/api/cli/approvals/[approvalId]/route.ts, the record a verify
 * reads: the status, the fingerprint of the action it was granted for, its
 * expiry and whether it has been spent. */
export function approvalRecord(fingerprint: string, overrides: Body = {}): Body {
  return {
    approvalId: "apr_1",
    status: "approved",
    fingerprint,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    used: false,
    ...overrides,
  };
}
