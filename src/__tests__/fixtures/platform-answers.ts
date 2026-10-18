
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

export const PUBLISH_EXPIRES_AT_EPOCH = 1791288000;

export function publishAnswer(overrides: Body = {}): Body {
  return {
    shareUrl: "https://acme.extension.dev/widget/builds/abc1234?share=tok_share",
    visibility: "private",
    buildSha: "abc1234",
    version: "1.2.0",
    builtAt: "2026-10-05T11:00:00.000Z",
    previewCommands: {
      chrome: "npx -y extension@latest preview https://registry.extension.land/acme/widget/_extension-dev/builds/abc1234/chrome.zip?t=tok_share",
    },
    token: "tok_share",
    expiresAt: PUBLISH_EXPIRES_AT_EPOCH,
    ttlHours: 168,
    ...overrides,
  };
}

export function publishAnswerWithLink(overrides: Body = {}): Body {
  const base = publishAnswer(overrides);
  const isPublic = base.visibility === "public";

  return {
    ...base,
    link: isPublic
      ? { kind: "build", url: base.shareUrl, expiresAt: null, pointsAt: "this build", audience: "public", scope: null }
      : {
          kind: "build",
          url: base.shareUrl,
          expiresAt: new Date(Number(base.expiresAt) * 1000).toISOString(),
          pointsAt: "this build",
          audience: "anyone with the link",
          scope: `build:${String(base.buildSha)}`,
        },
    projectVisibility: { value: base.visibility, source: "extension.dev project settings" },
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
  submitAnswer: "www src/app/api/cli/stores/submit/route.ts, one row per store, dispatched one at a time",
  publishAnswer: "www src/app/api/cli/publish/route.ts before link and projectVisibility, private project 200 with expiresAt in epoch seconds; a public project answers no token, expiresAt or ttlHours",
  publishAnswerWithLink: "www src/app/api/cli/publish/route.ts since 90907689d, the same keys plus link and projectVisibility",
  approvalRecord: "www src/app/api/cli/approvals/[approvalId]/route.ts, the record a verify reads",
} as const;
