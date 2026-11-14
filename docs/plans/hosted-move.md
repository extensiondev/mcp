# Hosted move: inventory and the CLI token seam

MCP ledger 644, steps 1 and 2 only. Written 2026-11-13 on branch `hosted-move`, cut from MCP main at 34c922a. Nothing here is code. Nothing here reaches MCP main or npm before Cezar releases 10.24.0, and nothing lands inside the 11-28 to 12-02 launch freeze.

Ruling in force (Cezar, 2026-11-13, option B): the logic of the platform tools leaves the public `@extension.dev/mcp` for a private, UNLICENSED package that mcp.extension.dev serves. The public package keeps the local tools and a forwarder, so tool names do not change. mcp.extension.dev also accepts the device-flow CLI token, checked by www's `/api/cli/whoami`, beside OAuth. It ships as 11.0.0. The repository stays public and Apache-2.0.

Held fixed by this plan, from the peer sessions:

- The public README, `server.json`, the tool list and the install line stay true for the npm version. This step changes none of them.
- The preview contract stays: the lab preview-verdict import, `extension_preview_web`'s fixed dev port (`DEFAULT_PREVIEW_DEV_URL`, `http://localhost:3110`, in `src/tools/preview-web.ts`) and the health shape in `apps/web/preview.extension.dev/vite.config.ts`.
- `src/__tests__/fixtures/preview-verdict.pin.json` and the three chrome-theme files vendored by `scripts/sync-chrome-theme-vendor.mjs` stay public. The graph confirms both: `src/lib/verdict.ts` is reached only by `extension_assert`, and `src/lib/vendor/chrome-theme/*` only by `extension_theme_verify`.
- `extension_create` and `extension_dev` stay local and unchanged.
- www `/api/cli/whoami` is used as it is, by bearer only. www `src/auth.ts` is not touched.

## 1. Two counts the plan page has wrong

The plan page and the ledger say 25 local tools, 15 platform tools, 6 that move whole and 9 that split. The code says otherwise. `src/lib/tool-policy.ts` puts 27 tools in the local group and 13 in the platform group, and the ruling's own lists name 6 whole moves and 7 splits, which is 13.

| Group | Count | Tools |
| --- | --- | --- |
| Local, stays | 27 | add_feature, analyze, assert, browsers, build, create, dev, docs_search, doctor, dom_snapshot, element, eval, inspect, list_extensions, logs, manifest_validate, network, open, reload, screenshot, start, stop, storage, templates, theme_verify, try, wait |
| Platform, moves whole | 6 | approvals, release_status, release_promote, shares, workspace, workspace_create |
| Platform, splits | 7 | auth, builds, preview_web, project_create, publish, submit, submit_check |

40 in all. The 25/15 split counted `docs_search` and `templates` with the platform group. The docs, the skill and the 11.0.0 changelog should say 27 and 13.

## 2. Inventory

### 2.1 Method

A script read every `import`, `export ... from` and dynamic `import()` in the repository at 34c922a and resolved the relative ones, 1,028 files in all. Type-only imports were dropped, since they vanish at build time. With them kept, 42 files form one import cycle; without them the only runtime cycle is three files: `approval-gate.ts`, `ship-act.ts` and `safari-release-intent.ts`.

For each of the 40 tool modules listed in `src/index.ts`, the script took everything it reaches. The server's own imports (`tool-dispatch.ts`, `tool-policy.ts`, `server-reload.ts`, `login-flow.ts` and the rest) were read the same way and marked as kernel. A file was then sorted by who reaches it, and every platform file was checked for `node:fs`, `node:child_process`, `node:os` or `node:zlib`, which marks a half that has to stay on the machine.

### 2.2 Counts per class

458 files under `src/tools` and `src/lib`.

| Class | Files | `src/tools` | `src/lib` | Lines |
| --- | --- | --- | --- | --- |
| Platform-only, moves | 145 | 41 | 104 | 27,151 |
| Platform, touches the machine, splits | 28 | 10 | 18 | 10,574 |
| Local-only, stays | 106 | 43 | 63 | 26,749 |
| Shared, stays public | 179 | 4 | 175 | 36,343 |

The shared class breaks down this way:

- 31 kernel files: the dispatcher, the tool policy, the envelope, credential scope, origins, retries, telemetry scrubbing and the server reload and stamp files. The forwarder needs every one of them.
- 69 local engine files (CDP, RDP, WebDriver, carriers, Safari dev options and the like). They count as shared only because `extension_preview_web` calls `extension_build` and `extension_open` for its local half. In practice they are local.
- 76 platform client files that local tools also reach, for example `registry.ts`, `platform-fetch.ts`, `project-api.ts`, `login-expired.ts`, `device-flow.ts`, `credentials.ts`, `approval-gate.ts`, `ship-act.ts`, the `store-md-*` family and `track-url.ts`. They stay public. The forwarder needs the credential, login and registry half of them anyway.
- 3 doc generators read at test time (`docs-json.ts`, `docs-meta.ts`, `docs-store-md-fields.ts`).

Appendix A lists every file by class.

### 2.3 What ties the kernel to platform code

Eleven runtime edges run from the shared kernel into platform-only files. Because of them, 25 platform-only files are loaded by the dispatcher whatever tool runs. Each edge has to be cut, or turned into a hook the private package registers, before anything can move:

| Kernel file | Imports, platform-only |
| --- | --- |
| `lib/tool-dispatch.ts` | `lib/store-answer.ts`, `lib/approval-open.ts` |
| `lib/no-login-for-project.ts` | `tools/store-listing.ts`, `lib/store-md-fields.ts`, `lib/held-batches.ts`, `lib/path-project.ts`, `lib/pending-creates.ts` |
| `lib/project-binding.ts` | `lib/connect-session-projects.ts`, `lib/path-project.ts` |
| `lib/secret-arguments.ts` | `lib/connect-session.ts` |
| `lib/approval-wait.ts` | `lib/act-outcome.ts` |

Four bridges also carry local tools into platform code. They decide whether the approval and store wording can close at all:

- `extension_create`: `create.ts`, then `store-md-toolchain.ts`, then `ship-act.ts`, then `approval-gate.ts`. The same path also reaches `project-api.ts`, `platform-fetch.ts`, `login-expired.ts` and `device-flow.ts`.
- `extension_analyze`: `analyze.ts`, then `store-review.ts`, then `firefox-enterprise.ts`, then `ship-act.ts`.
- `extension_build`: `build.ts`, then `tool-policy.ts`, then `submit-action-safety.ts`, then `approval-gate.ts`.
- `extension_doctor`: `doctor.ts`, then `project-engine-check.ts`, then `publish-link.ts`, then `package-address.ts`, then `registry.ts`.

`extension_create` must stay unchanged, so its bridge stays as it is, and so does everything it reaches. The cost: `approval-gate.ts`, `ship-act.ts`, `store-act-by-hand.ts` and the STORE.md readers stay public in 11.0.0. Closing them later means cutting what `store-md-toolchain.ts` takes from `ship-act.ts`, which is a change to `extension_create`'s import graph, though not to its behavior. That is a separate call, not part of this move.

## 3. The split list

What stays local in every forwarded call, whatever the tool:

- Picking the stored login and sending it: `credential-source.ts`, `credentials.ts`, `session-login.ts`, `private-file.ts`.
- Turning `projectPath` into a `workspace/project` ref: `project-binding.ts` (`bindCallProject`) and `path-project.ts` (`pathIdentity`, `loginForPath`, `loginForOrigin`), which read the project's `.git` and binding files.
- Opening a page in the person's browser: `approval-open.ts` (`openUrl`, `openPagesForPerson`, `openApprovalOnce`, `osOpenCommand`).
- The local approval record: `approval-record.ts` (`approvalRecordPath`, `rememberMintedApproval`, `standingApprovalForAct`, `mintedApproval`), which keeps `approvals.json` beside the credentials.

The forwarder sends the hosted server a project ref, never a path. The hosted server reads no local files, as it does today (`HOSTED_DROPPED_INPUTS` drops `api` and `projectPath`).

### 3.1 The seven split tools

| Tool | Local half, stays public | Hosted half, moves |
| --- | --- | --- |
| `extension_auth` | `tools/login.ts`: `loginToProject`, `loginToProjects`, `loginToWorkspace` (device code and poll, then the credential write). `tools/logout.ts`: `clearLocalCredentials`. `tools/auth.ts`: `projectAtPath`, and the logout branch of `handler`. `tools/whoami.ts`: `storedLogins`, `loginRows`. | `status`: `tools/whoami.ts` `readIdentity` and `describeServer` (the whoami call and its verdict), plus `lib/project-on-server.ts`, `lib/envelope-warnings.ts`. The wording of the login answers (`fail`, `success`, `pending`, `batchPending`, `movedProjectRefusal`, `missingProjectRefusal` and the rest in `tools/login.ts`) can move behind a hosted render call, or stay. See risk 3. |
| `extension_builds` | `tools/builds-download.ts`: `download` (fetch, sha256 check, file write) and `defaultArtifactsDir`, plus `lib/user-cache-dir.ts` `userCacheDir`. | Everything else: `builds.ts` and `builds-list.ts`, `builds-get-wait.ts`, `builds-logs.ts`, `builds-rebuild.ts`, `builds-rebuild-running.ts`, `builds-recheck.ts`, `builds-configure.ts`, `builds-channel.ts`, `builds-create-channel.ts`, `builds-acts.ts`, with `build-dispatches.ts`, `build-row-states.ts`, `build-usage.ts`, `build-browser-figures.ts`, `build-health.ts`. The hosted half of `download` answers the signed URL, the expected digest (`expectedFromReport`, `expectedFromRelay`) and the verdict words (`judge`, `describe`). |
| `extension_project_create` | `tools/project-create.ts`: `prepareUpload`, the device-code start and poll in `handler` and `finishFromPoll`, `pendingEnvelope`. `lib/source-archive.ts`: `buildSourceArchive`, `collectSourceFiles`, `readIgnoreFile`, `sourceManifestPath`, `looksLikeExtensionFolder`. `lib/pending-creates.ts`, `lib/held-batches.ts`. | `createWithGrant`, `sendCreate`, `createdByRead`, `closedLane`, `uploadFailed`, `sourceRequired`, `deadlineSentence`, with `project-create-body.ts`, `project-create-batch.ts`, `project-source-upload.ts` (the request, not the bytes), `create-answer.ts`, `create-ceiling.ts`, `create-login.ts`, `created-project-read.ts`, `first-build.ts`, `held-create-grant.ts`, `call-budget.ts`. |
| `extension_publish` | `tools/publish-captures.ts`: `syncCaptures` (reads the capture files). `lib/store-md-network.ts`: `storeMdNoNetworkPromise` (reads STORE.md, reached through `firefox-update-url.ts`). | `tools/publish.ts` whole (`handler`, `previewCommandsOf`, `sharePageField`, `linkIsShort`), `publish-captures.ts` `sendOne`, `refuseLocal`, `capturesTrackUrl`, with `lib/publish.ts`, `publish-artifacts.ts`, `publish-build-index.ts`, `publish-package-commands.ts`, `platform-share-read.ts`, `share-outcome.ts`, `share-page-probe.ts`, `build-links.ts`. |
| `extension_preview_web` | `tools/preview-web.ts`: `previewDevCheckout`, the build and open steps of `handler` (it calls `extension_build` and `navigateToUrl` from `extension_open`), the `buildShare` file read, `DEFAULT_PREVIEW_DEV_URL`. `lib/preview-upload.ts`: `collectDistFiles`, the byte upload in `uploadPreview`. `lib/project-ignore.ts`: `ensureProjectIgnored`, `insideRepository`. `lib/share-record.ts`: `recordSharedPreview`, `readSharedPreviews`. | The share request and its answer: `safeHostBase`, `clipHostClaim`, `expectedPreviewIdentifier`, `localLaneRemedy`, `unrequestedShare`, `previewOriginOf`, with `artifacts-api.ts`, `share-cors-probe.ts`. The preview contract stays local, so most of this tool stays public. It is the smallest hosted half of the seven. |
| `extension_submit` | `tools/submit.ts`: `storeMdWarnings`. `tools/store-listing.ts`: `readLocalListing`, the local reads in `syncListingRun`. `tools/store-connect.ts`: `openPages`. `lib/store-gallery.ts`: `shotOf`, `namedOnDisk`. `lib/store-listing-draft.ts`: `listingDraftOf`, `factsFor`. `lib/store-onboarding-decisions.ts`: `projectFactsOf`. `lib/store-preflight-local.ts`: `readJson`. `lib/store-release-loop.ts`: `safariReleaseOf`. `lib/chromewebstore-md.ts`: `readChromeWebStoreMd`. `lib/store-listing-icon.ts`: `localIcon`, `gitHead`. `lib/build-inputs.ts`: `localPackageHold`. | Everything else in `submit.ts` (`handler`, `judgeSubmit`, `storeOutcomes`, `connectionPrecheck`, the Safari and package refusal sentences) and the `store-*` tool files: `store-acts`, `store-configure`, `store-connect` (minus `openPages`), `store-first-submission`, `store-listing` (minus the local reads), `store-mint`, `store-publish-version`, `store-release`, `store-rollout`, `store-status`, `store-version-status`, with the 57 `lib` files only the two submit tools reach (Appendix A.1). |
| `extension_submit_check` | None of its own. `tools/submit-check.ts` is 52 lines over `submit.ts`, so its local half is `submit`'s: the STORE.md, icon, screenshot and git reads that `preflight` and `sync-listing` take from `projectPath`. | `handler`, `sharedProperty`. |

The local half of `submit` and `submit_check` reads the facts once and sends them as arguments: STORE.md text and its parsed listing, the built manifest per browser, icon and screenshot digests with the bytes uploaded straight to www, and the git HEAD. The hosted half judges them. This is the biggest piece of work in step 4.

### 3.2 The six "move whole" tools, read closely

Four of the six touch the machine somewhere. None of these changes the ruling. Each is a small local read the forwarder does before it forwards.

- `extension_approvals`: pure. Reaches `approval-record.ts` through `approval-verify.ts`; that record stays local (Section 3).
- `extension_release_status`: takes `projectPath`, and reaches `storeMdNoNetworkPromise` (through `store-status.ts`, `platform-submissions.ts`, `firefox-update-url.ts`) and `store-release-loop.ts` `safariReleaseOf`, which read STORE.md. The forwarder sends those two facts.
- `extension_release_promote`: reaches `storeMdNoNetworkPromise` through `firefox-update-url.ts`. Same fix.
- `extension_shares`: `list` and `revoke` read `.extension-dev/shared-previews.json` through `readSharedPreviews` when `projectPath` is passed. `create` (`tools/shares-create.ts` `createShareFromBuild`) downloads the build zip to a temp folder, reads its manifest and uploads it. That can run hosted, since it reads nothing of the person's. The local share record stays local. In practice `shares` is a split with a tiny local half.
- `extension_workspace`: pure. `workspace-login.ts` `storedLoginsOn` and `pickLogin` read the stored logins through the credential source, which the forwarder already holds.
- `extension_workspace_create`: runs a device-code approval (`requestDeviceCode`, `pollDeviceGrant`) but writes no credential. It keeps a held grant in `held-batches.ts` through `create-ceiling.ts`. The device start and poll can run hosted, because the person approves in their own browser from the URL in the answer. The held grant cannot live in the hosted server's `/tmp` (risk 2), so it moves to www or to the forwarder.

So the honest shape is 4 tools that move with no local read at all (approvals, workspace, and release_status and release_promote once the forwarder sends the STORE.md facts), and 9 with a local half: the 7 the ruling names, plus shares and workspace_create. The ruling's count of 9 splits holds, with a different pair than the plan page named.

## 4. Tests that move

531 test files under `src/__tests__`, sorted with the same graph:

| Fate | Files |
| --- | --- |
| Move with the platform code (import only platform or kernel files) | 219 |
| Import local and platform code, split by hand | 6 |
| Boot the whole server, stay public (`hosted-tools.test.ts` moves with `hosted.ts`) | 44 |
| Stay public untouched | 262 |

The six to split by hand: `project-binding.test.ts`, `refused-arguments-accepted.test.ts`, `release-status-project-path.test.ts`, `release-status-unbound-refusal.test.ts`, `small-claims-are-backed.test.ts`, `validate-input.test.ts`.

The 219 by owner are in Appendix B. The largest owners are submit and submit_check (108), tests spanning four or more platform tools (25), builds (19), publish (12) and auth (9).

The harnesses `builds-acts-harness.ts` and `hosted-platform-fetch.ts` move. `setup-session-dir.ts` and `envelope-validate.ts` are needed on both sides, so the private package takes a copy or imports them from a public test export.

Spec budget: the monorepo gate is billed per spec file and `scripts/spec-budget.json` ratchets each package. `apps/web/mcp.extension.dev` holds 2 spec files today, and public packages are outside the budget. Moving 219 test files into a monorepo package raises the gate bill by roughly that many files. Either the private package lives in its own private repository with its own CI, as the compiler and the emulator do (bootstrapped by `scripts/bootstrap-vercel-private-workspace.mjs`), or the 219 files are merged by owner first, under the test-audit skill.

## 5. mcp.extension.dev today and what changes

Today (monorepo `apps/web/mcp.extension.dev`):

- `server/http.ts` imports `createHostedServer` from `@extension.dev/mcp/hosted`, and `server/token.ts` imports the `ScopedProject` type from it. Those are the only two imports of the public package. `package.json` depends on `@extension.dev/mcp` as `workspace:*` and compiles it first (`mcp:compile`).
- `src/hosted.ts` in the public package projects 6 tools: `extension_auth` (status only), `extension_workspace` (info, projects, settings), `extension_project_create` (minus `projects`), `extension_builds` (every action but `download`, minus `to`), `extension_release_status` and `extension_release_promote`. It drops `api` and `projectPath` from every schema, refuses them with `E_TOOL_DISABLED` and status `hosted-unavailable`, and rewrites answers through `hostedAnswer` so a hosted client is never told to call a tool the hosted server lacks.
- Each request runs `handleMcp`: kill switch, then bearer read, then `validator.check` (www whoami, accepted only when `tokenKind` is `oauth` and `resource` is this server), then a rate limit of 120 a minute per token in memory, then one stateless MCP server per request, with the credential scoped through `withRequestCredential`.
- `prepareRuntime` points `XDG_CONFIG_HOME` at a temp folder and deletes `EXTENSION_DEV_TOKEN` and `EXTENSION_DEV_PROJECT`, so the server never holds a credential of its own.

What changes:

1. Imports. `createHostedServer` and `ScopedProject` come from the private package. `package.json` swaps the dependency and `mcp:compile` builds the private package. The public `./hosted` export goes away in 11.0.0.
2. The private package needs the public kernel: envelope, tool dispatch, policy, credential scope, request fetch, registry and project API. The public package grows a `./kernel` export for it, or the private package vendors a pinned copy. An export is the smaller change and keeps one source of truth.
3. Two lanes on one server. `/mcp` stays what it is for directory clients: OAuth only, the 6 projected tools, `hostedAnswer` rewrites, the OAuth challenge. A new `/mcp/forward` takes the forwarder's calls: OAuth or CLI token, all 13 platform tools with every action, the local server's wording, and refusals as JSON envelopes rather than challenges. `server/routing.ts`, `vercel.json` (one rewrite) and the `TOKEN_CHECKED_PATHS` set in `middleware.ts` each gain the path.
4. `server/token.ts` learns the CLI token kinds (Section 6.2) and returns the kind it accepted.
5. State. `approvals.json`, the held create grants and the pending creates live under `XDG_CONFIG_HOME`, which on Vercel is one function instance's `/tmp`. Two calls of the same approval round trip can land on different instances. That is already true of the 6 tools served today; with all 13 served it matters. These records move to www, or stay with the forwarder and travel as arguments.
6. Time. `api/mcp.ts` has `maxDuration` 60. The local tools wait inside their own budgets (`call-budget.ts`, `answerDeadline`, `waitSeconds`). The forward lane caps every wait at 50 seconds and answers with the same resume handle the tool already gives.
7. Tests go in the owner's existing spec files, `tests/mcp-endpoint.spec.ts` and `tests/units.spec.ts`, not new ones.

## 6. Auth seam design

### 6.1 Where the token is read

Only from the `Authorization: Bearer` header, by the existing `readBearer` in `server/token.ts`. A token in the query string, a cookie or the JSON-RPC body is ignored, and www whoami already refuses a token in the query by name (`token-in-query`). The forwarder also sends:

- `x-extensiondev-project: <workspace>/<project>`, when the call names a project. It is the same header `request-fetch.ts` `projectHeader` sends to www today.
- `x-extensiondev-forwarder: <package version>`, used only to refuse a stale forwarder in plain words and to log the version. It is not a credential and grants nothing.

### 6.2 How the hosted server calls www whoami

The same `createTokenValidator` as today, one `GET {MCP_WWW_API_BASE}/api/cli/whoami` with the bearer, an 8-second timeout. What changes is `isConnectedAppFor`, which becomes a lane check over whoami's answer:

| whoami answer | `/mcp` | `/mcp/forward` | Projects it covers |
| --- | --- | --- | --- |
| `tokenKind: "oauth"`, `resource` is this server | accepted | accepted | `projects`, the grant's list |
| `tokenKind: "member"` (device login for a whole workspace, Cezar's 11-10 ruling) | refused, OAuth challenge as today | accepted | `projects`, the signed `ps` list; each one is still checked live at every www door |
| no `tokenKind`, `login: "<ws>/<project>"` (the older seven-day project token) | refused, OAuth challenge as today | accepted | that one project |
| anything else: 401 or 403, no login and no projects, an OAuth token for another resource | refused | refused | none |

www stays the only judge of the token. The hosted server never verifies a signature itself, as the comment on `whoami-route.handlers.ts` asks of every door.

### 6.3 Caching

- Key: sha256 of the whoami URL and the token, never the token itself. That is today's `keyOf`.
- Valid answers are kept 60 seconds, capped by `expiresAt` when whoami sends one. A project token's whoami answer has no `expiresAt`, so it gets the 60 seconds.
- Invalid answers are kept 10 seconds. An unavailable answer (5xx, timeout) is never kept.
- At most 1,000 entries per function instance, oldest out first.
- When any www call inside a tool answers 401, `onUnauthorized` drops the entry. That already happens through `installRequestFetch`.
- The project header is not part of the key. The cache answers "is this a live token, and whose", never "may it touch this project". The project question is asked by www on every call (6.5).

### 6.4 Error codes, and how a refusal reads to the agent

The forward lane answers every refusal as the package's usual envelope `{ok: false, status, error: {code, message}, hint, value}` with HTTP 200, so the forwarder hands it to the agent as is. On `/mcp` nothing changes: HTTP 401 with the `WWW-Authenticate` challenge, which MCP clients turn into their OAuth flow.

| Case | Where it is decided | status | code | What the agent reads |
| --- | --- | --- | --- | --- |
| No stored login | forwarder, no network | `auth-required` | `E_AUTH_REQUIRED` | "extension_builds needs an extension.dev sign-in. Call extension_auth with action login; it opens the sign-in in the browser. Local tools keep working without it." |
| Stored login expired by its own clock | forwarder, no network | `auth-required` | `E_AUTH_EXPIRED` | "The login for acme/cat expired on <date>. Call extension_auth with action login to renew it." |
| No stored login covers the named project | forwarder, no network | `auth-required` | `E_NO_LOGIN_FOR_PROJECT` | Today's sentence from `no-login-for-project.ts`. |
| whoami refused the token (expired, revoked, other environment, same bytes from www) | hosted | `auth-refused` | `E_AUTH_DENIED` | "extension.dev refused this login: it was revoked, it expired, or it belongs to another environment. Call extension_auth with action login to sign in again." The forwarder does not delete the stored login on this answer; the person does that with logout. |
| Project not in the token's list | hosted, before any www call | `auth-refused` | `E_NO_LOGIN_FOR_PROJECT` | "This login covers acme/cat and acme/dog, not acme/bird. Sign in for acme/bird, or name a project it covers." |
| www door refuses the project (membership gone, 403 `TOKEN_PROJECT_MISMATCH`) | www, passed through by the tool | as the tool says today | `E_AUTH_DENIED` | The tool's existing sentence. |
| Rate limit | hosted | `rate-limited` | `E_PLATFORM` | "Too many platform calls from this login. Try again in 20 s." with `value.retryAfterSeconds`. |
| whoami unavailable (5xx, timeout) | hosted | `platform-unavailable` | `E_PLATFORM` | "extension.dev could not confirm this login just now. Try again shortly." with `value.retryAfterSeconds`. |
| Kill switch on | hosted | `hosted-off` | `E_PLATFORM` | "Platform tools are switched off for now. The local tools still work." |
| No network, DNS failure, TLS failure | forwarder | `offline` | `E_NETWORK` | "Platform tools need the network to reach mcp.extension.dev. The local tools still work." |
| Forwarder older than the hosted contract | hosted | `forwarder-stale` | `E_SERVER_STALE` | "Update @extension.dev/mcp to call extension_builds; this version is too old for the hosted contract." |

### 6.5 Project authorization on every request

This follows Cezar's 11-10 ruling: the login is scoped to the person, and each request is checked against the project.

1. The forwarder resolves the project locally (`bindCallProject`) and sends the ref in `x-extensiondev-project`.
2. The hosted server checks that the ref is in the token's list (`coveredProject` in `credential-scope.ts`, already there). That is a quick refusal, not the decision.
3. Every www call the tool makes carries the bearer and the same header (`installRequestFetch` already adds it for the www origin only). The www door decides on each call: `resolveMemberTokenProject` reads the mint record, its revocation and the person's live membership. A project token still works only inside its own project.
4. The hosted server never widens a token: it holds no credential of its own, mints nothing, and never stands in for a project the token does not name.

### 6.6 What someone who is not signed in still gets

In plain words, for the directory listings:

> Without an extension.dev account, all 27 local tools work as they do today: create an extension from a template, run it in a real browser, debug, test, analyze and build it, all on your own machine. The 13 platform tools still show up in the tool list, but each one answers right away, without calling any server, that it needs a sign-in, and names the one call that signs you in: `extension_auth` with action `login`, which opens the extension.dev sign-in page in your browser. Nothing from your project leaves your computer until you sign in and call a platform tool.

What makes that true in 11.0.0: `tools/list` comes from the pinned manifest offline; the no-login refusal is answered by the forwarder before any network call; and `extension_auth` `login` stays local.

## 7. Token seam security review

For Greg, on the token seam.

**Token passthrough.** The MCP authorization spec warns servers off accepting a token issued for another audience and passing it downstream. A CLI token's audience is www, not mcp.extension.dev, so accepting it is exactly that pattern, by ruling. Bounds on it:

- CLI tokens are accepted only on `/mcp/forward`. `/mcp`, the endpoint directories and third-party clients use, stays audience-bound to OAuth.
- The hosted server adds no authority: it holds no credential of its own, and every action is decided by www against the token's own claims.
- Later, the clean form is a token exchange: www mints a short-lived token with the mcp.extension.dev audience from the CLI token. That is a www change and is out of scope while `src/auth.ts` is being changed tonight. It is listed as a follow-up, not a blocker.

**Replay.** A bearer can be replayed by whoever holds it, so the work is keeping it from leaking:

- HTTPS only: `safeOrigin` refuses plain HTTP except on a loopback host.
- The token is never in a URL, so it never reaches access logs or referrers.
- The token is never logged (below).
- Expiry stays short: seven days for the device login. Revocation is live: the mint record is read at every www door, and the hosted cache drops an entry on the first 401.
- Two new rules:
  - The forwarder sends the token only to the pinned origin `https://mcp.extension.dev`, or to an override taken from the environment or a CLI flag, never from a tool argument or a project file. The override must pass the same HTTPS-or-loopback rule. Today's `api` tool input is exactly that kind of door, so it stays dropped on the forward lane.
  - Step 3 audits every `fetch` in the moved code, so the bearer goes only to the www origin. Today a stray bearer on a third-party URL leaks from the person's own machine; once hosted, it would leak from ours.

**Scope.** A forwarded call can do exactly what the same token can do against www directly, nothing more. Approval-gated acts (promote, submit, revoke, store connect and the rest) still need the human approval page, which www binds to the token and the action fingerprint. The forwarder does not skip that, and neither does the hosted server. Share-scoped and signed-in-lane tokens are refused by whoami, so they never pass.

**Project authorization per request.** As in 6.5, www decides on every call. The hosted list check is only a quick refusal. The 60-second cache cannot widen anything, because it never answers the project question.

**Rate limits.**

- Today: 120 a minute per token, in memory, per function instance, applied after whoami. Two gaps follow.
- A stranger with random tokens costs us one whoami call per request, since an invalid token is cached for only 10 seconds per token. Add a per-IP bucket before the whoami call for requests whose token is not in the cache.
- An in-memory limit is per instance, so the true ceiling grows with the instance count. Step 3 moves both buckets to a shared store, or accepts per-instance limits in writing.
- Local users' platform calls now count against the same limit and the same kill switch. The local default group stays the default, so a person who never signs in is never limited.

**Logging without the token.**

- Today's `log.ts` drops any field named like token, authorization, secret, password, cookie or bearer, redacts `Bearer ...` inside strings, and logs only `tokenId`, the first 16 hex characters of a sha256.
- Keep all of that. Add `lane` (`mcp` or `forward`), `tokenKind` (`oauth`, `member` or `project`) and the forwarder version.
- Never log call arguments. An agent can paste a store secret into a call (a private key, an AMO JWT secret, a Google client secret). The dispatcher refuses those today (`secret-arguments.ts` `secretArgumentRefusal`). The forwarder must run that refusal locally, before anything is sent, so a pasted secret never reaches mcp.extension.dev at all.
- Error logs carry the error name, never the message, since a message can quote an argument. `handleMcp` already does this.
- The `requestId` lets an operator join our line to www's `[cli/whoami] refused: <reason>` line without either side storing the token.

## 8. The three biggest risks

1. **The kernel is not separable yet.** Eleven kernel edges pull 25 platform files into the dispatcher, the approval gate sits in a three-file runtime cycle with `ship-act.ts` and `safari-release-intent.ts`, and four bridges carry local tools, `extension_create` among them, into platform code. The move cannot begin by moving files. It begins with a public refactor that inverts those edges into hooks, inside the public package, before 11.0.0. Some of the approval and store wording stays public until `extension_create`'s bridge is cut.
2. **State and time do not fit a serverless host.** Standing approvals, held create grants and pending creates are files under `XDG_CONFIG_HOME`, which on Vercel is per-instance `/tmp`. Waits in submit, builds and create can pass the 60-second function limit. With all 13 tools hosted, an approval round trip or a long wait can land on another instance and lose its state. Those records have to move to www or travel with the forwarder, and every wait needs a hosted cap with a resume handle.
3. **Splitting submit and submit_check is most of the work, and the tests come with it.** 108 of the 219 moving tests and 57 of the platform-only lib files belong to the submit pair. Its local half (STORE.md, icons, screenshots, built manifests, git HEAD) is spread across a dozen files. Moving those tests into the monorepo raises the gate's per-spec-file bill unless they merge first or the private package keeps its own CI.

## 9. What step 3 needs first

1. Cezar releases 10.24.0 from MCP main 34c922a. Until then everything stays on this branch.
2. Greg reviews Sections 6 and 7 on the token seam.
3. A home for the private package: its own private repository with its own CI, bootstrapped like the compiler and the emulator (recommended, because of the spec budget), or a monorepo package with the 219 tests merged first.
4. The first code, which is public and changes no behavior: cut the eleven kernel edges into hooks the private package registers, and add the `./kernel` export the private package will import. It ships inside a later 10.x or inside 11.0.0, never inside the launch freeze.
5. A www decision on where standing approvals, held create grants and pending creates live once hosted. This is the only step 3 item that touches www, and it does not touch `src/auth.ts`.

## Seams review (Greg)

Verdict: safe with changes. The forward lane adds no authority a CLI token does not already have at www, and every stranger path I could reach today is refused. It is not safe as written: two of the mechanisms in Sections 6 and 7 open a hole the moment they are coded in the obvious way, and the passthrough widens who can lose a seven-day token. The changes below come before any code. The token exchange comes before 11.0.0 ships.

### What I attacked

Live, as a stranger, with forged and malformed credentials only, on 2026-11-13:

| Attempt | Result |
| --- | --- |
| `POST mcp.extension.dev/mcp` with no token, a forged project token, a token in the query, a token in a cookie, a lowercase `bearer` scheme, a GET | 401 every time, with the OAuth challenge |
| Two `Authorization` headers on `/mcp` | 400 at the edge |
| `/mcp/forward` and `/api/mcp/forward` | 404, the lane does not exist yet |
| www `/api/cli/whoami` with no token, a forged token, a token in the query, a POST, a forged token plus a spoofed `x-forwarded-for` and a project header | 401 with the same bytes every time |

Offline, against copies of today's `server/token.ts` and `server/log.ts`:

- Cross-lane cache. `check(token)` caches the verdict of `isConnectedAppFor`, not the facts whoami returned, under a key with no lane in it. I added a lane the way Sections 5 and 6.2 describe (one extra parameter, the lane predicate inside `ask`). A member token checked first on `/mcp/forward` was then served "valid" on `/mcp` from the cache, with one whoami call in total. In the other order, a cold refusal on `/mcp` blocked the same token on `/mcp/forward` for 10 seconds.
- Logging. `scrubFields` dropped the `tokenKind` field Section 7 wants to add, because the key matches `/token/i`. A string that quotes a token without the word `Bearer` in front passed through unredacted.

### What I read in the code that changes the plan

- The `a` claim on every www token is the authority environment (`production:<repo>`), not a resource. A CLI token carries no audience that names mcp.extension.dev or www as a server. Only OAuth tokens carry a resource (`r`). So "audience binding" for the forward lane can only be enforced by the hosted server's own check on whoami's answer, or by a token that names the lane.
- `/mcp` already passes OAuth bearers through to www. Passthrough is not new with this move. What is new is the kind of token: a one-hour OAuth token for a few projects becomes a seven-day member token for up to the device batch cap of projects.
- www refuses connected-app tokens only at publish, submit and Safari signing assets. Every other door accepts them. The six-tool projection on `/mcp` is a UX layer, not a boundary: an OAuth client that wants more already sends the bearer to www directly.
- www's choke point refuses share, registry, provision and signed-in lane tokens before whoami answers, so the "no tokenKind" row in 6.2 is only the tracked project token. That claim in Section 7 holds.
- `safeOrigin`, cited in Section 7, does not exist in this clone. The HTTPS-or-loopback rule lives in `login-flow.ts` and covers the login flow only.
- Stored logins are keyed by the `api` origin that minted them (`credentialKey`, `serverOf`). That is the binding that keeps a token on its own server today, and the forwarder must not loosen it.
- No mutating door, in www or in the MCP, takes an idempotency key.
- The only IP-keyed limit on www's CLI doors is on `device/code`. The rest key on the token or the login, which survive forwarding.

### Must change before any code lands

1. **Cache the facts, decide the lane after.** The validator caches whoami's answer as facts (`tokenKind`, `resource`, `projects`, `expiresAt`, `login`) and nothing else. The lane predicate runs on every request after the cache read, never inside `ask`. A spec in `tests/units.spec.ts` warms a member token on `/mcp/forward` and asserts `/mcp` refuses it, then the reverse order. This is the bypass I reproduced, and the obvious diff walks into it.
2. **No OAuth on `/mcp/forward`.** The ruling says the forwarder holds the device login and no local OAuth, so no legitimate caller sends OAuth to the forward lane. Accepting it hands a third-party client all 13 tools with every action as ready-made calls, and mixes two principals in one lane's logs. The table in 6.2 becomes: OAuth for this resource on `/mcp` only; member and project tokens on `/mcp/forward` only.
3. **Accept by a positive fact, not an absence.** The project-token row is accepted only when the answer carries `login`, `projectId` and exactly one project, and no `resource`, `tokenKind` or `projects` list. Better, www whoami answers `tokenKind: "project"` explicitly. That is a one-line www change outside `src/auth.ts`, and it means a future token kind cannot fall into the accept row by omitting a field.
4. **Pair the forward origin to the credential's origin, from a closed table.** The forwarder derives the hosted origin from the stored login's `api`: `https://www.extension.dev` pairs with `https://mcp.extension.dev`, and a loopback www pairs with a loopback hosted server. An override is accepted only for loopback. No environment variable may point a production login at another HTTPS origin. Reason: environment variables are a project file in practice, since a project's `.mcp.json` sets them, and templates may now carry `.mcp.json` (Cezar 11-11). Under the rule in Section 7 as written, a cloned repository could set the override to its own HTTPS host and receive the person's production login on their first platform call.
5. **Never follow a redirect with a bearer.** Every fetch that carries the bearer, in the forwarder and in the hosted code, sets `redirect: "manual"` and treats a 3xx as an error. The audit in Section 7 covers origins; it must cover redirects too, or a same-origin URL that redirects becomes the leak.
6. **Per-IP limit before whoami, done right.** Key it on the platform's client address (`x-real-ip`, as www's `client-ip.ts` does), never on a value the client can set. Apply it to every request whose token is not in the valid cache. Before it, refuse locally anything that is not shaped like a www token (two base64url parts, sane length), which costs no whoami call. Keep invalid entries in their own bounded map, so a flood of random tokens cannot evict live entries and turn into a whoami storm. Be honest about what this is for: tokens are HMAC-signed, so there is no guessing a valid one; the limit protects cost, not the gate. Add a Vercel Firewall rule on the forward path as the cross-instance layer, or accept per-instance limits in writing.
7. **Nothing IP-keyed on www is reached through the hosted server.** `extension_workspace_create`'s device start (Section 3.2 proposes running it hosted) hits `device/code`, which limits by IP. Hosted, every user shares mcp.extension.dev's egress addresses, and one stranger exhausts the start for everyone. Keep the device start in the forwarder, or key that limit on the bearer when one is present.
8. **The cache is only an entry check.** The 60-second valid entry is safe only because www re-decides on every call. So no hosted tool may answer from hosted state alone with a cached token; each answer that carries data comes from a www call made with the bearer in that request. A spec revokes a token, then calls each of the 13 tools within the cache window and expects www's refusal. Keep the 10-second invalid entry, and keep never caching an unavailable answer.
9. **Logging.** Rename the field to `credentialKind`, or extend the scrubber's exception list, or the kind never reaches the log. Redact anything shaped like a www token (`<base64url>.<base64url>` of token length) inside strings, not only text after `Bearer`. Cap and charset-check `x-extensiondev-forwarder` before it is logged. Keep error names only, `tokenId` only, and no arguments. The local `secretArgumentRefusal` before send stays as Section 7 says.
10. **Replay of acts, not just tokens.** A captured bearer is a seven-day credential and nothing in this design changes that; that is the token exchange below. The new replay class is the forwarder's own retry: with a 50-second hosted cap, a submit, promote or revoke that timed out may have run. The forwarder never retries a mutating call on its own; it sends an idempotency key per act, and the hosted half passes it to www, which keeps the first outcome for that key. Confirm that an approval is consumed by the act it approved, so a replayed call cannot spend one approval twice.
11. **Headers to www are an allowlist.** The hosted half sends www the bearer, `x-extensiondev-project`, `content-type` and `accept`. Nothing the client sent is copied through, `x-forwarded-for` least of all.
12. **No CORS on `/mcp/forward`.** Only a Node forwarder calls it. `/mcp` answers `access-control-allow-origin: *` for directory clients; the forward lane has no reason to be callable from a page.
13. **A kill switch per lane,** so the forward lane can be turned off without taking `/mcp` down, and the reverse.

### The token exchange: mint now

Yes. Build it before 11.0.0 ships, and build the forward lane against it from the first line of code. Four reasons:

- **The first forwarder fixes the contract.** Whatever 11.0.0 sends to mcp.extension.dev, the hosted server accepts until the last 11.x is gone. Raw CLI tokens on the forward lane, shipped once, become a lane nobody can close without a major.
- **Blast radius.** mcp.extension.dev is a separate deployment with its own private dependency tree and its own logs. With raw passthrough, a compromise there, or one log line that slips, yields live seven-day member tokens that work from anywhere straight at www. With an exchange, it yields tokens that die in minutes and name one lane.
- **www can tell forwarded calls apart.** A distinct lane lets www revoke every hosted token at once, apply per-door policy the way it does for OAuth today, and attribute in its own logs.
- **It does not touch `src/auth.ts`.** It is a new `api/cli` route over `mintAccessToken` and `resolveReleaseTokenProject`, the same shape as the OIDC exchange route. The reason Section 7 gives for deferring it does not apply.

The shape: the forwarder posts its stored login to a www exchange route, on the www origin it already trusts, naming the forward resource. www checks the login live (revocation, membership), then mints a token with its own lane, the forward resource as `r`, at most the parent's project list, a life of ten minutes or less, and the parent's nonce, so revoking the parent kills the child at every door. The forwarder keeps the short token in memory and sends only that to mcp.extension.dev. The forward lane accepts only that lane with its own resource. Section 6.4's refusals stay as they are; `E_AUTH_DENIED` is answered by the exchange instead of by whoami.

This changes the letter of the 11-13 seam ruling (the hosted server would accept a token minted from the CLI token, not the CLI token itself) while keeping its intent (one device sign-in, no local OAuth). That is Cezar's call, so take it to him. If he keeps raw passthrough, the risk he accepts is stated plainly: anyone who reads one request off mcp.extension.dev holds that person's workspace login for up to seven days.

### Corrections to Sections 6 and 7

- Section 7 cites `safeOrigin`; the guard is in `login-flow.ts` and covers login only. The forwarder needs its own guard, per item 4.
- Section 7's "the hosted server adds no authority" holds for each token's reach at www. It does not hold for who can lose the token: the hosted server becomes a second place a seven-day token is visible.
- Section 6.2's table needs items 2 and 3 applied.
- Section 7's per-IP note needs items 6 and 7.

### Not covered here

- OAuth connected-app tokens reach every www door that is not marked `refuse`, whatever `/mcp` projects. The consent screen asks the person for projects, not actions. Whether a third-party app may promote, revoke shares or create workspaces is a product decision for Cezar and the board, not a seam fix, and it exists today with or without this move.
- I did not test whether Vercel overwrites a client-sent `x-real-ip` on mcp.extension.dev. Item 6 assumes it does, as www's `client-ip.ts` does; step 3 proves it with a probe before the limit ships.

## Appendix A. Every file under src/tools and src/lib


Generated from the runtime import graph at 34c922a (type-only imports left out, since they vanish at build time). "Reached by" means the tool module imports the file directly or through other files.

### A.1 Platform-only, moves (145 files)

- Reached by submit, submit-check (57): `lib/chrome-dashboard-paste.ts`, `lib/chrome-paste-lines.ts`, `lib/chrome-publisher-slots.ts`, `lib/chrome-visibility.ts`, `lib/connect-existing-answer.ts`, `lib/connect-existing.ts`, `lib/connect-session-projects.ts`, `lib/connect-session.ts`, `lib/firefox-category-cover.ts`, `lib/head-push.ts`, `lib/link-item-answer.ts`, `lib/listing-body-limit.ts`, `lib/listing-check-stage.ts`, `lib/listing-image-stage.ts`, `lib/listing-on-record.ts`, `lib/listing-record-compare.ts`, `lib/package-checks-build.ts`, `lib/preflight-detail.ts`, `lib/preflight-summary.ts`, `lib/review-promise.ts`, `lib/safari-app-record-step.ts`, `lib/safari-signing-expiry.ts`, `lib/safari-testflight-step.ts`, `lib/store-act-outcome.ts`, `lib/store-answer.ts`, `lib/store-bring-list.ts`, `lib/store-build-readiness.ts`, `lib/store-credential-failure.ts`, `lib/store-key-page-notes.ts`, `lib/store-listing-digest.ts`, `lib/store-listing-incomplete.ts`, `lib/store-md-chrome-reconcile.ts`, `lib/store-md-fields.ts`, `lib/store-md-host-justifications.ts`, `lib/store-md-over-limit.ts`, `lib/store-not-ready.ts`, `lib/store-onboarding-suppliers.ts`, `lib/store-onboarding.ts`, `lib/store-preflight-checks.ts`, `lib/store-refused-install.ts`, `lib/store-requirements.ts`, `lib/store-run-unavailable.ts`, `lib/submission-landing.ts`, `lib/submission-mode-view.ts`, `lib/submit-dispatch-bound.ts`, `lib/submit-local-precheck.ts`, `lib/submit-outcome.ts`, `lib/submit-run-cause.ts`, `tools/store-acts.ts`, `tools/store-configure.ts`, `tools/store-connect.ts`, `tools/store-first-submission.ts`, `tools/store-mint.ts`, `tools/store-publish-version.ts`, `tools/store-release.ts`, `tools/store-rollout.ts`, `tools/store-version-status.ts`
- Reached by release-status, submit, submit-check (17): `lib/approval-refund-words.ts`, `lib/browser-builds.ts`, `lib/chrome-item-left.ts`, `lib/edge-first-submission.ts`, `lib/platform-store-releases.ts`, `lib/platform-submissions.ts`, `lib/release-beside-submission.ts`, `lib/release-type-change.ts`, `lib/safari-listing-push-read.ts`, `lib/store-listing-push.ts`, `lib/store-read-landed.ts`, `lib/store-readiness.ts`, `lib/store-reads.ts`, `lib/store-refresh-dispatch.ts`, `lib/store-row-sources.ts`, `lib/store-upload-words.ts`, `tools/store-status.ts`
- Reached by builds (15): `lib/build-browser-figures.ts`, `lib/build-dispatches.ts`, `lib/build-row-states.ts`, `lib/build-usage.ts`, `tools/builds-acts.ts`, `tools/builds-channel.ts`, `tools/builds-configure.ts`, `tools/builds-create-channel.ts`, `tools/builds-get-wait.ts`, `tools/builds-list.ts`, `tools/builds-logs.ts`, `tools/builds-rebuild-running.ts`, `tools/builds-rebuild.ts`, `tools/builds-recheck.ts`, `tools/builds.ts`
- Reached by four or more platform tools (7): `lib/act-outcome.ts`, `lib/allowance.ts`, `lib/build-allowance.ts`, `lib/builds-list-row.ts`, `lib/channel-link.ts`, `lib/firefox-update-url.ts`, `lib/settings-write.ts`
- Reached by publish (7): `lib/platform-share-read.ts`, `lib/publish-artifacts.ts`, `lib/publish-build-index.ts`, `lib/publish-package-commands.ts`, `lib/share-outcome.ts`, `lib/share-page-probe.ts`, `tools/publish.ts`
- Reached by release-status (7): `lib/platform-store-listing.ts`, `lib/platform-visibility.ts`, `tools/release-history.ts`, `tools/release-list.ts`, `tools/release-ship-reads.ts`, `tools/release-status.ts`, `tools/store-listing-read.ts`
- Reached by workspace (7): `lib/project-rename.ts`, `tools/workspace-configure.ts`, `tools/workspace-environment.ts`, `tools/workspace-login.ts`, `tools/workspace-reads.ts`, `tools/workspace-visibility.ts`, `tools/workspace.ts`
- Reached by project-create (6): `lib/create-login.ts`, `lib/created-project-read.ts`, `lib/first-build.ts`, `lib/project-create-batch.ts`, `lib/project-create-body.ts`, `lib/project-source-upload.ts`
- Reached by project-create, workspace-create (4): `lib/call-budget.ts`, `lib/create-answer.ts`, `lib/create-ceiling.ts`, `lib/held-create-grant.ts`
- Reached by release-promote (4): `lib/promote-outcome.ts`, `lib/promote-record.ts`, `tools/release-acts.ts`, `tools/release-promote.ts`
- Reached by shares (3): `lib/build-links.ts`, `tools/shares-build-links.ts`, `tools/shares.ts`
- Reached by auth (3): `lib/project-on-server.ts`, `lib/server-identity.ts`, `tools/auth.ts`
- Reached by preview-web, shares (1): `lib/artifacts-api.ts`
- Reached by builds, publish (1): `lib/build-health.ts`
- Reached by auth, submit, submit-check (1): `lib/envelope-warnings.ts`
- Reached by preview-web, publish, shares (1): `lib/publish.ts`
- Reached by preview-web (1): `lib/share-cors-probe.ts`
- Reached by approvals (1): `tools/approvals.ts`
- Reached by submit-check (1): `tools/submit-check.ts`
- Reached by workspace-create (1): `tools/workspace-create.ts`

### A.2 Platform files that touch the machine, split (28 files)

Each one is reached only by platform tools but reads or writes the disk, runs git, or opens the browser. Section 3 names the functions that stay local.

`lib/approval-open.ts`, `lib/build-inputs.ts`, `lib/chromewebstore-md.ts`, `lib/held-batches.ts`, `lib/path-project.ts`, `lib/pending-creates.ts`, `lib/preview-upload.ts`, `lib/project-ignore.ts`, `lib/share-record.ts`, `lib/source-archive.ts`, `lib/store-gallery.ts`, `lib/store-listing-draft.ts`, `lib/store-listing-icon.ts`, `lib/store-md-network.ts`, `lib/store-onboarding-decisions.ts`, `lib/store-preflight-local.ts`, `lib/store-release-loop.ts`, `lib/user-cache-dir.ts`, `tools/builds-download.ts`, `tools/login.ts`, `tools/logout.ts`, `tools/preview-web.ts`, `tools/project-create.ts`, `tools/publish-captures.ts`, `tools/shares-create.ts`, `tools/store-listing.ts`, `tools/submit.ts`, `tools/whoami.ts`

### A.3 Local-only, stays (106 files)

`lib/background-liveness.ts`, `lib/boot-failed-stop.ts`, `lib/boot-verdict.ts`, `lib/build-id.ts`, `lib/capture-behind-window.ts`, `lib/capture-hidden-tab.ts`, `lib/capture.ts`, `lib/captured-in.ts`, `lib/carrier-exit.ts`, `lib/client-roots.ts`, `lib/compiled-not-attached.ts`, `lib/controlled-identity.ts`, `lib/doctor-production.ts`, `lib/element-act.ts`, `lib/element-input.ts`, `lib/element-types.ts`, `lib/engine-declared.ts`, `lib/eval-until.ts`, `lib/executor-stamp.ts`, `lib/extension-surfaces.ts`, `lib/gecko-no-scripting.ts`, `lib/gecko-sidebar-capture.ts`, `lib/isolated-run.ts`, `lib/json-value.ts`, `lib/legacy-stdout.ts`, `lib/network-stubs.ts`, `lib/network-watch.ts`, `lib/node-engine.ts`, `lib/one-expression.ts`, `lib/only-live-session.ts`, `lib/open-if-closed.ts`, `lib/page-open-for-check.ts`, `lib/producer-version.ts`, `lib/production-wait-words.ts`, `lib/profile-carryover.ts`, `lib/project-engine-check.ts`, `lib/relay-eval.ts`, `lib/safari-app-stage.ts`, `lib/safari-automation.ts`, `lib/safari-enable-blockers.ts`, `lib/safari-enable-log.ts`, `lib/safari-enable-probes.ts`, `lib/safari-enable-read.ts`, `lib/safari-eval.ts`, `lib/safari-extensions-plist.ts`, `lib/safari-person-steps.ts`, `lib/safari-session-notes.ts`, `lib/same-browser-session.ts`, `lib/server-crash-log.ts`, `lib/session-capabilities.ts`, `lib/session-idle.ts`, `lib/session-ports.ts`, `lib/start-answer.ts`, `lib/stop-ended.ts`, `lib/try-package.ts`, `lib/try-permissions.ts`, `lib/try-runs.ts`, `lib/types.ts`, `lib/vendor/chrome-theme/chrome-theme-color-math.ts`, `lib/vendor/chrome-theme/chrome-theme-reference.ts`, `lib/vendor/chrome-theme/chrome-theme-resolve.ts`, `lib/verdict-not-ready.ts`, `lib/verdict.ts`, `tools/add-feature.ts`, `tools/analyze.ts`, `tools/assert-network.ts`, `tools/assert-page-world-baseline.ts`, `tools/assert-page-world-dev.ts`, `tools/assert-page-world-globals.ts`, `tools/assert-page-world-reads.ts`, `tools/assert-page-world-verdict.ts`, `tools/assert-page-world.ts`, `tools/assert.ts`, `tools/browsers.ts`, `tools/create.ts`, `tools/detect-browsers.ts`, `tools/dev.ts`, `tools/docs-search.ts`, `tools/doctor.ts`, `tools/dom-snapshot.ts`, `tools/element-target.ts`, `tools/element.ts`, `tools/eval.ts`, `tools/get-template-source.ts`, `tools/inspect-gecko.ts`, `tools/inspect-schema.ts`, `tools/inspect.ts`, `tools/install-browser.ts`, `tools/list-browsers.ts`, `tools/list-extensions.ts`, `tools/list-templates.ts`, `tools/logs-constants.ts`, `tools/logs-filter.ts`, `tools/logs-schema.ts`, `tools/logs.ts`, `tools/network.ts`, `tools/reload.ts`, `tools/screenshot.ts`, `tools/start.ts`, `tools/stop.ts`, `tools/storage.ts`, `tools/templates.ts`, `tools/theme-verify.ts`, `tools/try.ts`, `tools/uninstall-browser.ts`, `tools/wait.ts`

### A.4 Shared, stays public (179 files)

- Server kernel used by every tool or by the dispatcher (31): `lib/analytics-scrub.ts`, `lib/approval-wait.ts`, `lib/call-waits.ts`, `lib/common-schema.ts`, `lib/credential-scope.ts`, `lib/dashboard-url-meter.ts`, `lib/deferred-warnings.ts`, `lib/docs-tools.ts`, `lib/engine-override-warning.ts`, `lib/engine-override.ts`, `lib/envelope.ts`, `lib/funnel-telemetry.ts`, `lib/no-login-for-project.ts`, `lib/origins.ts`, `lib/project-binding.ts`, `lib/retry.ts`, `lib/run-privacy.ts`, `lib/secret-arguments.ts`, `lib/server-crash-guard.ts`, `lib/server-reload.ts`, `lib/server-stamp.ts`, `lib/session-identity.ts`, `lib/session-order.ts`, `lib/stale-local.ts`, `lib/template-artifact-source.ts`, `lib/tool-annotations.ts`, `lib/tool-dispatch.ts`, `lib/tool-frames.ts`, `lib/tool-policy.ts`, `lib/untrusted-fence.ts`, `lib/validate-input.ts`
- Local engine reached by a platform tool only through extension_preview_web's local half (build, open) (69): `lib/act.ts`, `lib/amo-update-url.ts`, `lib/bridge-tab-list.ts`, `lib/bridge-tabs.ts`, `lib/build-type.ts`, `lib/carrier-registry.ts`, `lib/carrier.ts`, `lib/cdp-connection.ts`, `lib/cdp-devtools.ts`, `lib/cdp-extension-page.ts`, `lib/cdp-isolated-world.ts`, `lib/cdp-page-scripts.ts`, `lib/cdp-paused.ts`, `lib/cdp-port.ts`, `lib/cdp-targets.ts`, `lib/cdp.ts`, `lib/codesign.ts`, `lib/console-summary.ts`, `lib/context-menu-replay.ts`, `lib/contract-pids.ts`, `lib/dropped-runtime-pages.ts`, `lib/duplicate-assets.ts`, `lib/element-list.ts`, `lib/engine-version.ts`, `lib/executor-recovery.ts`, `lib/extension-identity.ts`, `lib/extension-reload.ts`, `lib/frame-json.ts`, `lib/frontmost-window.ts`, `lib/gecko-action-gesture.ts`, `lib/gecko-addon.ts`, `lib/gecko-sidebar.ts`, `lib/gecko-toolbar-click.ts`, `lib/guarded-api-uses.ts`, `lib/guest-load-oracle.ts`, `lib/injection-refusal.ts`, `lib/local-state.ts`, `lib/match-patterns.ts`, `lib/observe-surface.ts`, `lib/process-identity.ts`, `lib/process-manager.ts`, `lib/production-launch.ts`, `lib/production-receipt.ts`, `lib/rdp-port-notes.ts`, `lib/rdp.ts`, `lib/safari-background.ts`, `lib/safari-base-url.ts`, `lib/safari-build-options.ts`, `lib/safari-dev-options.ts`, `lib/safari-signing.ts`, `lib/safari-webdriver-request.ts`, `lib/session-browser.ts`, `lib/session-receipt.ts`, `lib/special-folder-entries.ts`, `lib/start-landing.ts`, `lib/store-review.ts`, `lib/tab-foreground-by-id.ts`, `lib/tab-foreground.ts`, `lib/tab-switch-worker.ts`, `lib/tab-view.ts`, `lib/target-pick.ts`, `lib/templates-cache.ts`, `lib/wait-modes.ts`, `lib/webdriver.ts`, `lib/xcode-teams.ts`, `tools/build.ts`, `tools/manifest-validate.ts`, `tools/open-menu-item.ts`, `tools/open.ts`
- Platform client code that local tools also reach (76): `lib/approval-gate.ts`, `lib/approval-lines.ts`, `lib/approval-login.ts`, `lib/approval-outcome.ts`, `lib/approval-page-trace.ts`, `lib/approval-policy.ts`, `lib/approval-record.ts`, `lib/approval-scope.ts`, `lib/approval-subject.ts`, `lib/approval-verify.ts`, `lib/ask-only.ts`, `lib/browser-captures.ts`, `lib/browser-family.ts`, `lib/console-urls.ts`, `lib/created-projects.ts`, `lib/credential-server.ts`, `lib/credential-source.ts`, `lib/credentials.ts`, `lib/device-flow.ts`, `lib/device-wait.ts`, `lib/edge-listing.ts`, `lib/engine-manifest-view.ts`, `lib/exec.ts`, `lib/firefox-enterprise.ts`, `lib/firefox-store.ts`, `lib/hand-upload.ts`, `lib/json-object.ts`, `lib/launch-flags.ts`, `lib/login-expired.ts`, `lib/login-flow.ts`, `lib/manifest-by-browser.ts`, `lib/package-address.ts`, `lib/platform-fetch.ts`, `lib/platform-hold.ts`, `lib/platform-store-records.ts`, `lib/png-flat.ts`, `lib/private-file.ts`, `lib/project-api-bytes.ts`, `lib/project-api.ts`, `lib/project-batch.ts`, `lib/project-identity.ts`, `lib/project-manifest.ts`, `lib/project-move.ts`, `lib/publish-link.ts`, `lib/publish-localized-name.ts`, `lib/registry-access.ts`, `lib/registry.ts`, `lib/request-fetch.ts`, `lib/review-beside-submission.ts`, `lib/safari-release-intent.ts`, `lib/scaffold-scripts.ts`, `lib/session-login.ts`, `lib/session-paths.ts`, `lib/ship-act.ts`, `lib/store-act-by-hand.ts`, `lib/store-capture.ts`, `lib/store-categories.ts`, `lib/store-code-facts.ts`, `lib/store-connection.ts`, `lib/store-listing-media.ts`, `lib/store-md-bounded.ts`, `lib/store-md-bullets.ts`, `lib/store-md-declarations.ts`, `lib/store-md-listing.ts`, `lib/store-md-safari-title.ts`, `lib/store-md-screenshots.ts`, `lib/store-md-toolchain.ts`, `lib/store-md-words.ts`, `lib/store-md.ts`, `lib/store-screenshot-sizes.ts`, `lib/store-settings.ts`, `lib/store-text-limits.ts`, `lib/submit-action-safety.ts`, `lib/token-refusal.ts`, `lib/track-url.ts`, `lib/zip-entries.ts`
- Doc generators read at test time (3): `lib/docs-json.ts`, `lib/docs-meta.ts`, `lib/docs-store-md-fields.ts`

## Appendix B. Tests by owner

Built from the same graph over `src/__tests__`. A test moves when everything it imports from `src` moves or is kernel; it stays when it imports only local or kernel files.

### B.1 Move with the platform code (219 files)

- submit and submit_check (108): `approval-next-call.test.ts`, `bring-list-ledger-408-409.test.ts`, `chrome-dashboard-paste.test.ts`, `chrome-icon-padding.test.ts`, `dashboard-url-meter.test.ts`, `edge-certification-notes-source.test.ts`, `firefox-key-pair.test.ts`, `firefox-release-per-amo-channel.test.ts`, `firefox-signed-words.test.ts`, `firefox-store.test.ts`, `hand-upload.test.ts`, `preflight-answer-once.test.ts`, `preflight-before-first-sync.test.ts`, `preflight-compact-answer.test.ts`, `preflight-firefox-category-verdict.test.ts`, `preflight-firefox-rule-with-no-build.test.ts`, `preflight-package-hold.test.ts`, `preflight-safari-app-record-step.test.ts`, `preflight-says-once.test.ts`, `record-wait-retries-a-missed-read.test.ts`, `registry-submission-id.test.ts`, `release-beside-submission.test.ts`, `safari-builds-off.test.ts`, `safari-fresh-read-caller.test.ts`, `safari-listing-locked.test.ts`, `safari-lock-decision.test.ts`, `safari-release-intent-approvals.test.ts`, `safari-release-next-step.test.ts`, `safari-release-type-change-words.test.ts`, `safari-release-type-words.test.ts`, `safari-signing-expiry.test.ts`, `safari-testflight-next-step.test.ts`, `store-acts.test.ts`, `store-bring-list.test.ts`, `store-categories.test.ts`, `store-configure.test.ts`, `store-connect-existing.test.ts`, `store-connect-session.test.ts`, `store-connect-wait-binds-project.test.ts`, `store-connect-walk-words.test.ts`, `store-connection-source.test.ts`, `store-edge-first-submission.test.ts`, `store-first-submission.test.ts`, `store-listing-icon.test.ts`, `store-listing-incomplete.test.ts`, `store-listing-screenshot-sizes.test.ts`, `store-listing.test.ts`, `store-md-app-store-name.test.ts`, `store-md-contract.test.ts`, `store-md-host-bullets.test.ts`, `store-mint-signing.test.ts`, `store-onboarding-listing-draft.test.ts`, `store-onboarding-readiness.test.ts`, `store-onboarding-suppliers.test.ts`, `store-publish-covered-line.test.ts`, `store-publish-draft-state.test.ts`, `store-publish.test.ts`, `store-reads.test.ts`, `store-release-failed-upload.test.ts`, `store-release-loop.test.ts`, `store-release-row-newest-version.test.ts`, `store-requirements.test.ts`, `store-run-approval-refund.test.ts`, `store-safari-approved.test.ts`, `store-safari-publish-refusals.test.ts`, `store-safari-release.test.ts`, `store-status-absent-records.test.ts`, `store-status-hand-and-unknown-sources.test.ts`, `store-status-login-expired.test.ts`, `store-status-poll-run-read.test.ts`, `store-status-refresh-shared-check.test.ts`, `store-status-review-beside.test.ts`, `store-status-status-read.test.ts`, `store-status-store-reads.test.ts`, `store-status-store-version.test.ts`, `store-status.test.ts`, `store-submission-run.test.ts`, `submission-mode-view.test.ts`, `submit-action-safety.test.ts`, `submit-cancel-cause.test.ts`, `submit-channel-label.test.ts`, `submit-check-asks.test.ts`, `submit-check-listing-stage.test.ts`, `submit-dispatch-bound.test.ts`, `submit-edge-package-refused.test.ts`, `submit-edge-review-lock-hint.test.ts`, `submit-edge-unreadable-review-lock.test.ts`, `submit-edge-upload-words.test.ts`, `submit-outcome.test.ts`, `submit-priced-refusal.test.ts`, `submit-review-promise-follows-lines.test.ts`, `submit-rules.test.ts`, `submit-run-failure-cause.test.ts`, `submit-status-dry-run-after-release.test.ts`, `submit-status-landed-source.test.ts`, `submit-status-one-link.test.ts`, `submit-status-release-without-newer-dry-run.test.ts`, `submit-version-follow-ups.test.ts`, `sync-listing-body-limit.test.ts`, `sync-listing-image-stage.test.ts`, `sync-listing-ledger-407-411-412-413.test.ts`, `sync-listing-locked.test.ts`, `sync-listing-screenshot-master.test.ts`, `sync-listing-screenshots-on-record.test.ts`, `sync-listing-staged-fingerprint.test.ts`, `sync-listing-store-folder.test.ts`, `workspace-reconnect-state.test.ts`, `workspace-store-accounts.test.ts`
- four or more platform tools (25): `act-outcome.test.ts`, `allowance.test.ts`, `approval-gate.test.ts`, `approval-round-trip.test.ts`, `build-allowance.test.ts`, `builds-get-unfinished.test.ts`, `builds-list-one-truth.test.ts`, `builds-logs-running.test.ts`, `builds-named-by-number.test.ts`, `builds-tool.test.ts`, `firefox-update-served.test.ts`, `firefox-update-url.test.ts`, `login-expired-renewal.test.ts`, `no-login-for-project.test.ts`, `package-address.test.ts`, `platform-hold.test.ts`, `platform-sentences-match-the-platform.test.ts`, `push-cost-words.test.ts`, `release-status-channel-source.test.ts`, `session-identity-legs.test.ts`, `session-login-holds.test.ts`, `spend-narration.test.ts`, `submit-local-precheck.test.ts`, `submit-next-step-follows-the-record.test.ts`, `submit-tool.test.ts`
- builds (19): `builds-acts-configure.test.ts`, `builds-acts-create-channel.test.ts`, `builds-acts-rebuild.test.ts`, `builds-cancelled-run.test.ts`, `builds-channel.test.ts`, `builds-configure-defaults.test.ts`, `builds-download.test.ts`, `builds-get-browser-figures.test.ts`, `builds-get-browser-scope.test.ts`, `builds-get-safari-not-recorded.test.ts`, `builds-get-usage-default.test.ts`, `builds-logs-shared-failure.test.ts`, `builds-rebuild-after-finished.test.ts`, `builds-rebuild-already-running.test.ts`, `builds-rebuild-approval.test.ts`, `builds-recheck.test.ts`, `builds-run-handle.test.ts`, `platform-fetch-bound.test.ts`, `user-cache-dir.test.ts`
- publish (12): `publish-artifact-health.test.ts`, `publish-build-pin.test.ts`, `publish-channel-link.test.ts`, `publish-commands-are-shell-safe.test.ts`, `publish-envelope.test.ts`, `publish-localized-name.test.ts`, `publish-outcome.test.ts`, `publish-page-sha-and-share-page.test.ts`, `publish-preview-commands.test.ts`, `publish-public-link.test.ts`, `publish-share-page-held.test.ts`, `publish-sync-captures.test.ts`
- auth (9): `auth-batch-login.test.ts`, `auth-status-per-project.test.ts`, `auth-wildcard-login.test.ts`, `credentials-unreadable-store.test.ts`, `login-discovery.test.ts`, `logins-per-server.test.ts`, `logout-outcome.test.ts`, `renamed-project-login.test.ts`, `whoami-server-identity.test.ts`
- release-status (7): `release-history.test.ts`, `release-list-visibility.test.ts`, `release-status-store-filter.test.ts`, `safari-withdrawal-beside-review.test.ts`, `ship-reads.test.ts`, `store-listing-read.test.ts`, `store-submission-by-id-and-poll-lanes.test.ts`
- workspace-create and project-create (6): `call-api-picks-every-url.test.ts`, `create-answer-rules.test.ts`, `create-outcome-after-a-timeout.test.ts`, `create-stuck-ceiling.test.ts`, `project-create-batch.test.ts`, `single-create-answers-in-time.test.ts`
- workspace (5): `workspace-configure.test.ts`, `workspace-environment.test.ts`, `workspace-includes.test.ts`, `workspace-tool.test.ts`, `workspace-visibility.test.ts`
- shares and preview-web (4): `artifacts-api-rules.test.ts`, `platform-reads-wave5.test.ts`, `shares.test.ts`, `zip-url-redirect.test.ts`
- release-promote (3): `promote-outcome.test.ts`, `promote-record.test.ts`, `release-acts.test.ts`
- auth and project-create (3): `auth-and-create-sentences.test.ts`, `device-code-wait.test.ts`, `login-project-missing-on-server.test.ts`
- shares (3): `shares-build-links.test.ts`, `shares-from-build.test.ts`, `shares-revoke-token.test.ts`
- shares and publish and preview-web (2): `login-hint-names-project-create.test.ts`, `publish-token.test.ts`
- builds and publish (2): `builds-get-unrecorded-browser.test.ts`, `publish-artifacts-served-browsers.test.ts`
- preview-web (2): `preview-web.test.ts`, `share-cors-probe.test.ts`
- approvals and submit and submit-check (2): `approval-batch-and-page-trace.test.ts`, `submit-version-approval.test.ts`
- project-create (2): `create-blocking-call-keeps-its-token.test.ts`, `project-create.test.ts`
- workspace and project-create (1): `project-rename.test.ts`
- release-promote and submit and submit-check (1): `ship-approval-always-asked-wording.test.ts`
- approvals (1): `approvals-revoke.test.ts`
- release-promote and auth (1): `whoami-identity.test.ts`
- workspace-create (1): `workspace-create.test.ts`

### B.2 Import both local and platform code, split by hand (6 files)

`project-binding.test.ts`, `refused-arguments-accepted.test.ts`, `release-status-project-path.test.ts`, `release-status-unbound-refusal.test.ts`, `small-claims-are-backed.test.ts`, `validate-input.test.ts`

### B.3 Import the server entry, stay public (44 files)

These boot the whole server. `hosted-tools.test.ts` is the exception: it tests `src/hosted.ts` and moves with it. `tool-count.test.ts`, `docs-match-the-code.test.ts` and `server-instructions*.test.ts` keep pinning all 40 names through the offline manifest.

`approval-login-survives-rebuild.test.ts`, `approval-survives-rebuild.test.ts`, `batch-policy.test.ts`, `channel-link.test.ts`, `chrome-store-goal-path.test.ts`, `cli-login-provider.test.ts`, `credential-source-parity.test.ts`, `dead-engine-override-warns-every-answer.test.ts`, `deployment-doctrine.test.ts`, `docs-match-the-code.test.ts`, `element.test.ts`, `envelope-shape.test.ts`, `eval-until.test.ts`, `hand-started-session-adopted.test.ts`, `headless-input-and-tool-path-next-steps.test.ts`, `hosted-tools.test.ts`, `lifecycle-wave6.test.ts`, `listed-schema-follows-reload.test.ts`, `merged-tools.test.ts`, `named-project-ref.test.ts`, `preflight-landing-line.test.ts`, `project-move-follows.test.ts`, `project-pin.test.ts`, `project-ref-refusal.test.ts`, `release-version-gate.test.ts`, `renamed-project-answers-both-names.test.ts`, `run-recipe-is-one-call.test.ts`, `server-instructions-window.test.ts`, `server-instructions.test.ts`, `server-reload.test.ts`, `server-stale-refusal.test.ts`, `server.test.ts`, `session-sentences-and-engine-rules.test.ts`, `store-connection.test.ts`, `submit-check-tool.test.ts`, `submit-status-action.test.ts`, `tool-count.test.ts`, `tool-description-budget.test.ts`, `tool-descriptions.test.ts`, `tool-list-budget.test.ts`, `tool-policy.test.ts`, `tool-result-frame.test.ts`, `track-url-on-every-platform-act.test.ts`, `untrusted-fence.test.ts`

### B.4 Stay public untouched (262 files)

31 import only local files, 221 import local and kernel files, 10 import nothing from `src`. They include `verdict-contract.test.ts`, which reads `src/__tests__/fixtures/preview-verdict.pin.json`, and the chrome-theme vendor checks.
