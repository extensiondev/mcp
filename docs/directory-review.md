# Directory review: the hosted server

The hosted server at `https://mcp.extension.dev/mcp` serves six tools of this package through
`src/hosted.ts`. This page is the audit of those six against the Claude connector review
(https://claude.com/docs/connectors/building/review-criteria, read 2026-11-11) and the OpenAI
plugin review (https://developers.openai.com/apps-sdk/app-submission-guidelines, read 2026-11-11).
It is kept current by `src/__tests__/hosted-tools.test.ts`, which pins the title and the four
hints of every hosted tool.

## The tools

| Tool | Name length | title | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | Mixes read and write across actions | Answer text naming a plan, price or upgrade |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `extension_auth` | 14 | Read the signed-in identity | true | false | true | true | No: hosted serves `status` alone | None |
| `extension_workspace` | 19 | Read the workspace | true | false | true | true | No: hosted serves `info`, `projects`, `settings`, all reads | None of its own since this audit; `value.plan` relays the platform's allowance record as the console shows it |
| `extension_project_create` | 24 | Create a project | false | false | false | true | No: one operation | None of its own; a refused create relays the platform's sentence |
| `extension_builds` | 16 | Read and rebuild builds | false | true | false | true | Yes: `list`, `get`, `logs` read; `rebuild`, `recheck`, `configure`, `create-channel`, `configure-channel`, `delete-channel` write | None of its own; a refused rebuild relays the platform's sentence and its `upgradeUrl` |
| `extension_release_status` | 24 | Read the release status | true | false | true | true | No: one read with `include` | None |
| `extension_release_promote` | 25 | Promote a release | false | true | false | true | No: `promote`, `cut`, `rollback` all write | None of its own; a refused release relays the platform's sentence and its `upgradeUrl` |

Every tool lists its title twice, as the tool's `title` (MCP 2025-06-18) and as
`annotations.title`, and every hint is an explicit boolean (`listedToolEntry` in
`src/lib/tool-dispatch.ts`). A hosted projection with fewer actions than its module names its own
title and hints in `src/hosted.ts`; the rest come from the table in `src/lib/tool-annotations.ts` through `src/lib/tool-policy.ts`. The `download`
action and its `to` input are not served hosted: they save a package to the caller's disk, which
a hosted server does not have.

## Transport and sign-in, read by hand on 2026-11-11

- Transport: Streamable HTTP, stateless, JSON answers (`StreamableHTTPServerTransport` with
  `enableJsonResponse: true` in the monorepo's `apps/web/mcp.extension.dev/server/http.ts`). A
  GET on the endpoint answers 405 once signed in; no SSE stream is offered.
- `POST /mcp` with no token answers 401 with
  `WWW-Authenticate: Bearer error="invalid_token", error_description="No authorization provided", resource_metadata="https://mcp.extension.dev/.well-known/oauth-protected-resource/mcp"`.
  An unauthenticated `initialize` is refused, so `tools/list` is read from the code and its
  tests, not from the live server.
- `/.well-known/oauth-protected-resource/mcp` answers `resource: "https://mcp.extension.dev/mcp"`
  and `authorization_servers: ["https://www.extension.dev"]`; the root document answers
  `resource: "https://mcp.extension.dev"`.
- `https://www.extension.dev/.well-known/oauth-authorization-server` answers a
  `registration_endpoint` (dynamic client registration, RFC 7591),
  `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`,
  `grant_types_supported: ["authorization_code", "refresh_token"]` and
  `scopes_supported: ["projects", "offline_access"]`. It does not advertise
  `client_id_metadata_document_supported`, so Claude registers through DCR on every fresh
  connection.
- `https://mcp.extension.dev/.well-known/openai-apps-challenge` answers 404: the OpenAI domain
  proof is not served yet.

## Open items

1. `extension_builds` mixes reads and writes under one `action` input. The MCP specification
   carries one `annotations` object per tool and none per action, so a `tools/list` cannot label
   `list` read-only and `rebuild` destructive on the same tool; the tool is listed non-read-only
   and destructive, which is what the Claude review's "Separate read and write tools" rule flags
   and what the OpenAI review's "expose each operation as a separate tool" rule reads the same
   way. The fix is a split at the policy table: a read-only `extension_builds` (`list`, `get`,
   `logs`) and a write tool for `rebuild`, `recheck`, `configure` and the channel actions.
2. A refused rebuild, release or create relays the platform's own sentence and, when the platform
   sends one, `value.upgradeUrl`. The platform's sentence for a spent monthly allowance names the
   paid tier and its price, by the www invariant "the price rides on the refusal, in the server's
   words" (2026-11-06). The OpenAI review refuses pricing, subscription and upgrade text inside a
   plugin. Whether the platform keeps that sentence off answers to connected-app tokens is the
   owner's decision, not this package's.
3. The OpenAI domain proof (`/.well-known/openai-apps-challenge`) is served only once the
   submission form hands out its token.
4. Reviewer accounts for both directories are hand steps for the owner; see the checklist below.

## Reviewer account checklist

One account, one workspace, one sample project in every state a reviewer would look at. Nothing
here is created by an agent.

- [ ] A workspace owned by a review-only sign-in (a password sign-in with no second factor, no
      magic link and no sign-up step, as the OpenAI review requires; the Claude review asks for
      "a fully populated account").
- [ ] One project with a connected store (Chrome Web Store is enough) so `extension_release_status`
      answers store status.
- [ ] A build that ran and passed, so `extension_builds` `list`, `get` and `logs` answer rows and
      lines.
- [ ] A release on Preview and one on Stable, so `extension_release_status` answers channels and
      history and `extension_release_promote` has a build to move.
- [ ] A refused submit on record (a store the project is not connected to, or a build with no
      artifact for it), so a negative test case has a refusal to show.
- [ ] A store submission still pending review, so the status page and the history carry a held
      release.
- [ ] Claude review: the account's sign-in, the server URL, confirmation that every tool was run
      in MCP Inspector and as a custom connector, a public documentation page
      (https://docs.extension.dev/tools/mcp), a privacy policy link, a support contact and at
      least three example prompts.
- [ ] OpenAI review: the same account without a second factor, five positive test cases (prompt,
      expected tools, expected behavior), three negative test cases, a demo video the reviewer
      can open, release notes, and the domain proof served at
      `https://mcp.extension.dev/.well-known/openai-apps-challenge`.

## Reviewer test cases

The OpenAI review takes exactly five positive and three negative cases; the Claude review reads
the same account. Every case runs against the reviewer account of the checklist above, with its
sample project called `<workspace>/<project>` below, from a client signed in to
`https://mcp.extension.dev/mcp`. "Expected tools" are the hosted tools in call order. The
expected answers are derived from the answer builders in `src/tools` and `src/lib` at the commit
this page was written; a line marked "to replay after the www promote" quotes words the platform
composes, which production www does not serve yet, and is confirmed by one replay once the
promote lands. The tests in `src/__tests__/docs-match-the-code.test.ts` pin the eight headings.

### Positive 1: Who am I signed in as

- Prompt: "Which extension.dev account and project is this connection signed in as?"
- Expected tools: `extension_auth` (`action: "status"`).
- Expected answer: `ok: true`, `value.workspaceSlug` and `value.projectSlug` naming the reviewer's
  workspace and project, `value.server.verdict: "confirmed"` from the platform's whoami read,
  `value.expiresAt` for the connection's token, and a warning that reads "This connection renews
  on its own. Revoke it under the project's Settings, Connected apps:
  https://console.extension.dev/<workspace>/<project>/settings/connected-apps". The answer never
  says "7 days", "re-mint", "Access tokens" or "stored on this machine", and never returns the
  token (`src/tools/whoami.ts`, pinned by `hosted-tools.test.ts`).

### Positive 2: Which projects does the workspace hold

- Prompt: "List the projects in my extension.dev workspace and tell me which one failed its last build."
- Expected tools: `extension_workspace` (`action: "projects"`).
- Expected answer: `status: "listed"`, `value.projects` with one row per project and its last build,
  and the hint "<workspace> has N projects" followed by "; the last build failed for <project>"
  when one did (`readProjects` in `src/tools/workspace.ts`). The hint's closing sentence names
  `extension_auth (action: "login", ...)`, which the hosted server does not serve; a reviewer
  reads it as the local server's step. To replay after the www promote: the exact row fields.

### Positive 3: Did the latest build pass

- Prompt: "Did the latest build of <workspace>/<project> pass? Show me its log if not."
- Expected tools: `extension_builds` (`action: "list"`), then `extension_builds`
  (`action: "get", buildId`), then `extension_builds` (`action: "logs", buildId`) only when the
  build did not pass.
- Expected answer: the list answers "N recent builds of <workspace>/<project>, newest first; the
  latest is <build words>, <pins>. Pass action:\"get\" or action:\"logs\" with a buildId to read
  one." (`src/tools/builds-list.ts`); the get answers `status: "read"` with `value.build`,
  `value.artifacts`, `value.integrity` and the hint "Build #N (<sha>) is success; every integrity
  check passed. It is held by <channel> for <browsers>. Pass action:\"logs\" with this buildId
  for its log lines." (`src/tools/builds.ts`); the logs answer the run's lines for the browser
  asked. To replay after the www promote: the exact build words and pin sentence of the sample
  build.

### Positive 4: Where does the project stand on the stores

- Prompt: "What is the release and store status of <workspace>/<project>?"
- Expected tools: `extension_release_status` (default `include: ["releases", "stores"]`).
- Expected answer: `status: "read"` with `value.releases` (the channels, what each serves,
  `recentBuilds`, the builds page URL) and `value.stores` (the connected store, the pending
  submission and the refused one from the sample account). The releases section's hint reads
  "Shas on record: <channel lines>; recent builds add <shas>. Use one as buildId/buildSha for
  promote/deploy/publish; ..." (`src/tools/release-list.ts`) and the stores section's hint ends
  "This is the registry's recorded state (submissions and the review poller write it), with the
  platform's own submission records and their runs; the store dashboards are authoritative and
  may be ahead of it." (`src/tools/store-status.ts`). A section the platform could not read
  answers `status: "partial"` with a warning naming it, never an empty section. To replay after
  the www promote: the exact channel and submission rows.

### Positive 5: Release the latest Stable build to Preview

- Prompt: "Release the latest successful build of <workspace>/<project> to the Preview channel."
- Expected tools: `extension_release_status` or `extension_builds` (`action: "list"`) to pick the
  buildId, then `extension_release_promote` (`buildId, channel: "preview"`), then the same call
  again with `approvalId` once a workspace owner approved.
- Expected answer: the first promote answers `ok: false`, `status: "approval-required"`,
  `error.code: "E_APPROVAL_REQUIRED"`, `value.approvalId` and `value.approvalUrl`, the message
  "Release build <sha> to the preview channel. This is irreversible, so a human must approve it
  first. Open <approvalUrl> to review and approve, then call extension_release_promote with the
  same arguments and approvalId <id>. ... Nothing was executed." and the person's line "Approve
  at <approvalUrl>; then extension_release_promote with the same arguments and approvalId <id>
  runs it." (`src/lib/approval-gate.ts`). The reviewer approves at the link as the workspace
  owner. The second call answers `ok: true` with the release record and the channel now serving
  the build. The message's reading step names `extension_approvals {action: "status", ...}`,
  which the hosted server does not serve; the reviewer calls `extension_release_promote` again
  with the `approvalId` instead. To replay after the www promote: the released answer's exact
  status and hint.

### Negative 1: Release a Preview build to Stable

- Prompt: "Release build <preview-only sha> of <workspace>/<project> to the Stable channel."
- Expected tools: `extension_release_promote` (`buildId, channel: "stable"`).
- Expected refusal: the platform refuses the release because Stable takes only builds made for
  Stable (`buildEnv: "production"`), and the server answers `ok: false`,
  `status: "promote-failed"`, `error.platformCode: "BUILD_ENV_MISMATCH"` and the hint "Preview
  takes any build; Stable and every other channel take Stable builds, and this build is not one.
  Rebuild this commit for Stable (Builds, Rebuild in the console, or extension_builds
  action:\"rebuild\" with this buildId and buildEnv:\"production\"), wait for it to pass, then
  release it again. To ship this build as it is, release it to Preview instead."
  (`promoteRefusalHint` in `src/tools/release-promote.ts`). Why: a Stable release is what the
  stores receive, and a staging build was not made for it. To replay after the www promote:
  whether the platform refuses before the approval is asked (`refusedBeforeApproval: true`, no
  approval spent) or only on the approved call.

### Negative 2: Rebuild past the monthly build allowance

- Prompt: "Rebuild the latest commit of <workspace>/<project>." on a workspace whose monthly
  build allowance is spent.
- Expected tools: `extension_builds` (`action: "rebuild"`).
- Expected refusal: `ok: false`, `status: "rate-limited"`, `error.code: "E_PLATFORM"`,
  `error.name: "BuildsRefused"`, `error.platformCode: "monthly_cap"`, `value.retryAfterSeconds`,
  and the hint is the platform's own sentence, which begins "This build was refused and nothing
  was dispatched: ..." (`actRefusal` in `src/tools/builds-acts.ts` relays the message of a
  `monthly_cap` refusal as it is). Why: the allowance is the workspace's, and the server never
  dispatches past it. Today the platform's sentence continues with the paid tier and its price
  and the answer carries `value.upgradeUrl` (open item 2 above); the review refuses that text, so
  this case is written for the answer without the offer and is to replay after the www promote
  and the owner's ruling on open item 2.

### Negative 3: Create a project in a workspace the reviewer cannot write

- Prompt: "Create a project called <name> in the <other> workspace from github.com/<owner>/<repo>."
  where the reviewer is not a member of `<other>`.
- Expected tools: `extension_project_create` (`repo, workspace: "<other>", name`), then the
  same call with `deviceCode` and `waitSeconds`.
- Expected refusal: the first call answers `ok: true`, `status: "authorization-pending"` with
  `value.verificationUri`, `value.userCode` and `value.deviceCode` and the hint "Open <link> and
  approve creating the project (code <code> is pre-filled). ..." (`src/tools/project-create.ts`),
  because creating a project is approved by a signed-in workspace member on
  extension.dev/device. The reviewer, who is not a member of `<other>`, cannot approve it there;
  the resumed call then answers `ok: false`, `status: "create-denied"`,
  `error.code: "E_AUTH_DENIED"`, `error.name: "CreateDenied"` and the message "Creating the
  project was denied at extension.dev/device (<code>): <platform sentence>." Why: a project is
  created only where the approving member can write. To replay after the www promote: the
  platform's denial code and sentence on the approval page for a workspace the approver is not
  in.
