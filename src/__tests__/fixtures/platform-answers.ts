
type Body = Record<string, unknown>;

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

export const PLATFORM_WRITERS = {
  promoteAnswer: "www src/app/api/projects/[projectId]/releases/releases-route.create.ts via /api/cli/release/promote",
  projectCreatedAnswer: "www src/app/api/clone/core/create-project-from-clone/seed-and-build.ts via /api/cli/projects/create",
  submitAnswer: "www src/app/api/cli/stores/submit/route.ts, one row per store, dispatched one at a time",
  publishAnswer: "www src/app/api/cli/publish/route.ts, private project 200; a public project answers the same keys with no expiry",
  approvalRecord: "www src/app/api/cli/approvals/[approvalId]/route.ts, the record a verify reads",
} as const;
