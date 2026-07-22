# Changelog

## 5.3.1

### Added

- `extension_login` pending results lead with the one-click device link
  when the flow provides one (RFC 8628 `verification_uri_complete`): the
  user opens it and approves with the code pre-filled, no typing. The
  bare URI and code stay in the result as the fallback for flows that
  cannot prefill.
- `extension_deploy` and `extension_release_promote` accept each other's
  spelling for the same build commit: deploy folds a `buildId` argument
  onto its canonical `buildSha`, and promote folds `buildSha` onto its
  canonical `buildId`. Full-schema validation errors enumerate the new
  aliases alongside the rest of the contract.

### Fixed

- Resuming `extension_login` with a `deviceCode` while authorization is
  still pending no longer claims a userCode of "(see the previous
  response)". Only a hash of the code is stored, so it cannot be echoed
  again; the result now says plainly that the one-click link and code
  from the previous response are still valid, to open that link (or
  enter the code at the verification URI), then call `extension_login`
  again with the same deviceCode.

## 5.3.0

The DevX surprise swarm ran ten personas over the full create-to-release
journey and ranked five blocker clusters. All five land here.

### Added

- `extension_release_list`: the discovery sibling of the release verbs.
  Lists the project's channels (channel to promoted build sha) and recent
  builds from the public registry (registry.extension.land), so a caller
  can pick a valid `buildSha` for `extension_release_promote`,
  `extension_deploy`, or `extension_publish` instead of hunting the
  console. Read-only, needs no auth for public projects. Tool count is
  now 32.
- A shared public-registry client (`src/lib/registry.ts`) that reads
  meta, channels, the build index, and store credential health. Reads
  are best-effort: a registry blip never fails the verb it decorates.

### Fixed

- `extension_create` announces every decision it took without being
  asked. The resolved destination path leads the result, and
  `defaultsApplied` names each silent choice (server cwd, package
  manager, browser, git init) as one. Validation errors now teach the
  full argument schema, required, optional, and aliases, instead of
  revealing one missing field per attempt.
- `extension_dev` no longer forks sessions. A second call on the same
  projectPath used to return ok:true while its browser died on the
  profile lock; it now detects the live session and refuses, or stops it
  first with `replace:true` and says so. A dead browser leg no longer
  rides an ok:true envelope: the ready contract's `browser_exited` stamp
  and the profile-lock signature both surface as failures.
- `extension_stop` finds orphaned sessions. It unions the in-memory
  registry with the on-disk session markers, so a session whose dev
  child exited (exactly when the orphaned browser most needs stopping)
  is still found, verified, and reaped. A stale marker yields an honest
  stopped:false and is pruned, never a phantom kill.
- `extension_deploy` dry runs stopped echoing an unqualified
  "Preflight OK". The preflight now reads per-store credential health
  from the registry and reports each browser as actionable, not
  configured, or unverifiable, with the console stores URL in the
  result. The silently defaulted channel is disclosed and checked
  against channels.json. Under dryRun a platform error now reads
  "preflight failed", never "submit failed".
- `extension_release_promote` dead-ends carry the way out: a 404 or
  UNKNOWN_BUILD error now includes each channel's currently promoted
  sha, the registry URL it read, and the console Builds page URL, plus
  a pointer to `extension_release_list`.
- `extension_publish` says what the share link serves: the build sha,
  build time, version, and channel behind the URL, resolved from the
  registry's build index, with a note when it is the newest successful
  build rather than a pinned one.

## 5.2.0

### Added

- `extension_manifest_validate` warns when a Chrome-desktop-only manifest
  key (for example `file_browser_handlers`) rides an Edge target, where it
  is inert. Family-level prefix resolution already worked; this adds
  granularity inside the chromium family for Edge-targeted publishers.
- `extension_logout` now returns `revokeUrl` pointing at the project's
  access-tokens page and says plainly that the token stays valid
  server-side until revoked there. The scope is read before the local
  credentials are cleared so the link can still be built.

## 5.1.2

### Fixed

- `extension_logs` no longer flags a healthy live session as stale. Newer
  engine canaries stamp log and event rows with ready.json's `instanceId`
  rather than its `runId`, so the staleness check compared ids from two
  different spaces and every live read carried `stale: true` with a
  do-not-trust warning. The comparator now accepts either identity field,
  pinned by a test against the real contract shapes. (Filed upstream as
  Extension.js bug 77 so the ready/logs contract agrees on one field.)

## 5.1.1

### Added

- `extension_deploy` warns when a Firefox or Edge submission ships without
  the STORE.md notes the platform submits automatically (Firefox reviewer
  and release notes, Edge certification notes). The warnings ride along in
  the result as `warnings` and never block the submission; Chrome-only
  submissions stay silent.

## 5.1.0

The engine closed its entire open bug range (Extension.js 61-73) in the
4.0.14 canary line. This release re-aligns the MCP with the fixed engine,
finishes the MCP-side half of those bugs, and continues the
report-failure-not-false-success program that 5.0.0 started. 5.0.0 was never
published to npm; installing 5.1.0 picks up both.

### Fixed

- **Sessions now genuinely survive the MCP process.** `detached: true` alone
  never did it: the child held pipes to the MCP, so when the MCP exited the
  next compile log line killed the dev server with EPIPE. Launch tools
  (`extension_dev`/`start`/`preview`) now stream the child's output to a
  session log file (returned as `logPath`) instead of pipes. A detached
  session outlives the MCP and a fresh MCP process rediscovers it through
  `ready.json` and can stop it. Pinned by a detach-contract test.
- **`extension_preview` no longer reports `launched` for a process that died
  in seconds.** It health-checks the child like `dev`/`start` (the MCP half of
  engine bug 72), and all three launch tools read the engine's new
  `browser_exited` stamp, so a browser that dies after launch (for example a
  rejected add-on) returns `status:"browser-exited"` instead of success.
- **`extension_doctor` names a dead browser.** A `browser_exited` ready
  contract now produces a runtime-errors failure that says the browser died,
  with the matching remedy, instead of the generic "fix the build error"
  wording that pointed at a build that was fine.
- **`extension_create` verifies the scaffold.** A resolved create over a
  partial tree (an interrupted template download) returned `nextSteps`
  pointing at a project that could not compile. It now checks the manifest
  exists and returns `status:"incomplete"` when it does not.
- **`extension_manifest_validate` is per-target honest.** `chromium:`/
  `firefox:` prefixed keys resolve per target, `edge` joins the default
  matrix, `manifest_version` must be 2 or 3, a `default_locale` without its
  `_locales` catalog blocks, and a missing 128px store icon warns
  (`extension_inspect` reports `has128Icon`).
- **Stale state stops being served as live.** `extension_logs` stamps
  `stale:true` when the producing session is dead or from a different run;
  `extension_wait` returns `runtimeErrors` alongside ready instead of a bare
  green over a crashing worker; `extension_build` reports
  `productionDivergence` when the production manifest lost permissions or
  resources relative to source.
- **`extension_open`'s `asTab` fallback fires on the user-gesture wall**, and
  `extension_storage` set without a `key` answers in MCP vocabulary rather
  than CLI flags.

### Added

- **Structured bundler warnings on `extension_build`.** The engine now
  persists its build summary to `dist/extension-js/<browser>/
  build-summary.json` (the transport half of engine bug 73), and the tool
  returns it as `buildWarnings` (with `buildWarningsTruncated` naming the
  true count when the engine capped the list). Older engines simply omit the
  field; nothing is scraped from stdout.
- **Popup-faithful headless rendering.** A popup rendered as a tab is now
  sized like the real popup: the document's content size is measured over
  CDP, clamped to Chrome's 25x25-800x600 popup bounds, and the window is
  resized to it (reported as `renderedAsTab.popupBounds`). If the browser
  does not verifiably honor the resize, the tool keeps saying "no popup
  sizing" instead of implying fidelity. Note headless-new is one such
  browser: it accepts `Browser.setWindowBounds` and changes nothing, so
  headless sessions get the honest fallback, not a resized window. The
  measurement also leaves `body`'s authored width alone; only the root takes
  the temporary fit-content override, so a popup that sizes itself through
  `body { width }` measures at its real width.
- **CI typechecks the tests.** `pnpm typecheck` covers `src/` and the test
  tsconfig, wired into the CI matrix, so type drift between tools and their
  tests cannot accumulate silently again.

### Changed

- **Tool prose caught up with the fixed engine.** `extension_eval` and
  `extension_dom_inspect` now advertise the surface contexts
  (`popup`/`options`/`sidebar`/`devtools`) and override pages
  (`newtab`/`history`/`bookmarks`) the engine's relay serves, needing no tab
  id. The "content eval is known-broken" guard is version-honest: on
  Extension.js >= 4.0.14 a null is the expression's real result, and the note
  says so instead of condemning a repaired path. Firefox hints name every
  working route.

A pass focused on a single question: when something has gone wrong, does the
tool say so? Five tools were reporting success over a failure. All five now
verify before they claim anything.

### Breaking

- **`extension_build` refuses a broken build.** It runs the
  `extension_manifest_validate` checks as a preflight and returns
  `status:"blocked"` on build-blocking errors instead of shelling out to a build
  it knows is broken. Pass `skipValidation: true` for the old behavior. It also
  returns `success:false` with `status:"incomplete"` when the bundler exits 0 but
  a declared entrypoint never reached `dist/`, because the browser refuses to
  load that artifact. Non-blocking findings ride along as `manifestWarnings`.
- **Browser resolution defaults to `chrome`, not `chromium`.** A dead session
  used to fall through to a blind default, so every call after a dev server
  exited silently retargeted a browser the caller never ran. A dead session now
  resolves to its own browser with `source:"stale"`.
- **`extension_open` renames `tab` to `target`.** The value is a CDP target id,
  not a `chrome.tabs` id, and the old name invited callers to pass it straight
  into tools that need a numeric tab id.

### Fixed

- **`extension_doctor` no longer reports `healthy:true` over a crashing
  extension.** Its runtime-error check read the wrong field, so every error row
  in `logs.ndjson` collapsed to an empty string and was skipped. It now reads the
  engine's `messageParts` payload, with an `errorName`/`stack` fallback, and
  collapses a throw that repeats on every event.
- **`extension_dev` and `extension_start` no longer report `status:"started"`
  for a server that already exited.** Both health-check the child process and
  return `status:"exited"` with the exit code, signal, and the child's own output
  as evidence.
- **`extension_open` no longer reports success for a navigation that failed.**
  Navigating to a `chrome-extension://` origin is cross process and swaps the
  render frame, so the pre-navigation session reported a stale error URL on
  success and success on failure. It now confirms against a fresh target list.
  This affected the `url` navigation path shipped in 4.9.0, not only the new
  surface rendering.
- **`extension_open` targets the right extension.** A dev session also loads
  Extension.js's own manager extension, and taking the first extension target
  navigated against the wrong origin. The id is now derived from the dist path
  the session actually loaded.

### Added

- **Headless surface rendering.** `extension_open` accepts `asTab` for
  `popup`/`options`/`sidebar`, rendering the surface document in a real tab so it
  can be inspected where no window exists to host a popup. It is applied
  automatically when a headless session refuses to open the surface, with a note
  saying what was substituted.
- **Tab targeting by url.** `extension_eval` and `extension_dom_inspect` take a
  `url` and otherwise default to the active tab, and `extension_dom_inspect`
  gains `listTabs` for discovery. The engine gained this in 4.0.13; the tool
  descriptions had been telling callers a numeric tab id was required.
- **Friendlier arguments.** `timeoutMs`, `lines`, `tabId`, `href` and
  `browserName` fold onto their canonical names, `withConsole` accepts `true`,
  and the input validator understands union types.
- **`extension_create` matches your package manager.** Hints and the engine
  warning now use bun, pnpm or yarn when that is what the scaffold used, and the
  warning reads the pin the scaffold actually wrote.

## 4.9.0

A second pass from the persona swarm, closing the gaps 4.8.0 left and the top
new blockers it surfaced.

- **Honest `extension_manifest_validate`.** It now scans the project source for
  permission-gated `chrome.*`/`browser.*` calls and flags any the manifest does
  not declare, an API used without its permission is `undefined` at runtime and
  crashes the context, the exact case where validate used to report `valid:true`.
  The headline is now honest (`valid:false` + `buildBlocking:true` on any error),
  and it accepts singular `browser` as an alias for `browsers`.
- **`extension_open` can navigate a tab.** Pass a `url` (Chromium, via CDP) to
  drive a content-script test page, a `webNavigation` target, or the popup as a
  page (`chrome-extension://<id>/popup.html`), the loop the surface-only open
  could not do. `target` is accepted as an alias for `surface`.
- **`extension_stop` actually reaps the session.** It now terminates the dev CLI
  and both browser families (gecko profile + chromium `--load-extension`, under
  the project's dist) and refuses to report `stopped:true` while any survive.
- **`extension_wait` won't lie about a dead session.** A `ready.json` whose pid
  is dead now returns `status:"stale"` instead of `ready`, so you don't walk into
  a reload/eval that fails with a misleading control-channel error.
- **Dropped-channel errors name the real cause.** A `1006` / "no control channel"
  now detects an exited dev server (stale ready.json + dead pid) and says so,
  instead of asking "is the session started with allowControl?" when it was.
- **`extension_doctor`** surfaces recent error-level logs as a `runtime-errors`
  check (so a background throwing on every event isn't `healthy:true`), keeps the
  project-local engine version in project mode, and flags when that engine
  differs from a pinned `EXTENSION_MCP_CLI_VERSION`.
- **`extension_build`** lists declared entrypoints in its success output, so a
  content script no longer reads as "didn't build".
- **`extension_create`** forces non-interactive git (`GIT_TERMINAL_PROMPT=0`) so a
  credential prompt can't hang the template download, retries once on a transient
  network/timeout failure (cleaning the partial dir first), reports a download
  failure as such instead of "choose a valid template name", and warns when the
  scaffold's `extension@latest` pin will win over your pinned CLI.
- Eval/inspect error guidance now speaks MCP JSON args (`context`, `tab`, `url`)
  instead of CLI flags.

## 4.8.0

Dev-session ergonomics hardened from a 30-persona agent walk of the toolchain.

- **`allowEval` now implies `allowControl`.** Enabling eval on `extension_dev`
  also opens the control channel, so a single `allowEval: true` unlocks
  `extension_storage`/`reload`/`open`/`dom_inspect` too. `extension_dev` now
  returns a `capabilities` block naming exactly which verbs the session unlocked,
  ending the stop-and-restart loop that hit agents who passed one flag and not
  the other.
- **Session-aware browser default.** `extension_stop` (and the other
  browser-scoped tools) resolve the browser from the one live session for the
  project instead of assuming `chrome`. `extension_stop` also reaps the launched
  browser's process tree and refuses to report `stopped: true` while a process
  survives, fixing orphaned browsers (notably Firefox) after a stop.
- **Forgiving argument names.** Common synonyms are accepted and normalized:
  `path`/`dir` for `projectPath`, `name` for `projectName`, `template` for
  `slug`, `code` for `expression`, and more, so a reasonable first guess no
  longer 400s.
- **`extension_manifest_validate`** accepts `projectPath` (it finds the
  manifest) and probes path-valued fields (popup, service worker, icons, content
  scripts) against disk, warning on dangling references instead of a false
  all-clear.
- **`extension_doctor`** inlines the dev session's own recorded errors so a build
  or load failure no longer reads as healthy.
- **`extension_inspect`** lists declared entrypoints (so a small content script
  is not buried under assets) and warns when a store-listing promo image is
  shipped inside the package.
- **`extension_source_inspect`** on a Gecko session now names the working
  alternatives (`extension_logs`, `extension_eval`) instead of pointing back at
  the tool that just refused.

## 4.7.0

`extension_deploy` now submits **through** extension.dev instead of driving a
local CLI. Pass `browsers` + `buildSha` and the submission is routed to the
platform, which holds your store credentials and dispatches the release from
your project's mirror CI; authentication is your `extension_login` session or a
release token in `EXTENSION_DEV_TOKEN`, and it defaults to a dry run. The tool
is now a thin authenticated client of the platform's store-submission endpoint,
exactly like `extension_publish` and `extension_release_promote`, with no
external CLI dependency. This replaces the previous mode that shelled out to a
standalone local CLI. Direct zip-based submission with store credentials in the
environment is no longer exposed through the MCP; use your own CI pipeline for
that.

## 4.6.0

New `extension_deploy` tool (31 tools total): submit a built extension to the
Chrome Web Store, Firefox AMO, and Edge Add-ons by driving a standalone
deploy CLI. Store targets are inferred from the `.zip` paths
you pass. It defaults to a dry run, and store credentials are read from the
environment or a `.env.submit` file, never from tool arguments, so secrets
never enter the agent transcript.

## 4.5.0

The platform client (GitHub device-code login, the credential store, and the
publish flow) is now vendored directly in this package instead of the
separate `@extension.dev/core` dependency. No behavior change: the tool
schemas, the credential file, token resolution, and the publish error
envelopes are all unchanged. This drops a runtime dependency and the
two-package release step.

## 4.4.0

Browser-matrix parity release: the tool surface now mirrors the engine
CLI flag for flag, and a 30th tool cleans up the managed browser cache.

- New tool `extension_uninstall_browser`. Removes a managed browser
  binary from the Extension.js cache (or every one with `all: true`).
  Only touches the managed cache, never system-installed browsers.
- Full Extension.js browser matrix in `extension_detect_browsers`: all
  eleven supported browsers (chrome, chromium, edge, brave, opera,
  vivaldi, yandex, firefox, waterfox, librewolf, safari) are probed,
  each reported with its engine family and whether the managed
  installer can provision it.
- Shared browser-launch flags on `extension_dev`, `extension_start`,
  and `extension_preview`: `profile` (path, or `"false"` to reuse the
  default user profile), `startingUrl`, `chromiumBinary` /
  `geckoBinary` custom binaries, `host` / `publicHost` for Docker and
  devcontainer splits, and companion `extensions` loaded alongside the
  project.
- `extension_build` closes its gaps against the engine CLI:
  `zipFilename`, `polyfill`, `silent`, and `mode`
  (development/production/none, also sets NODE_ENV).
- Engine dependencies bumped to ^4.0.11.
- The shipped debugging docs are rewritten around the live inspect
  surface.
- Release plumbing: npm publishes now carry provenance from a
  changelog-backed GitHub workflow, the npm README renders the logo at
  the right width via pack hooks, and the Safari web extension keyword
  aids npm discovery.

## 4.3.0

Diagnosis + version-skew release: a 29th tool that turns "an act tool
errored, now what" into one call, and a CI that tests the engine
versions users actually run.

- New tool `extension_doctor`. Wraps `extension doctor --output json`:
  walks the dev session's control-channel legs (ready contract,
  dev-server process, control-port agreement, control channel, eval
  token, executor, browser liveness) and returns one
  `{check, status, detail, remediation?}` entry per leg in dependency
  order. Detail and remediation prose are rewritten to MCP-speak like
  every other act-verb error. Engines that predate the `doctor` verb get
  a clean CliError with a hint instead of a crash.
- Browser-family classification now has ONE copy
  (`src/lib/browser-family.ts`). Fixes real drift: `browsers:
  ["chromium"]` ran ZERO family checks in `extension_manifest_validate`
  (an MV2 manifest validated "fine"), and `chromium` was still missing
  from the `extension_build` / `extension_dev` / `extension_preview` /
  `extension_start` schema enums.
- CI version-skew matrix: every push builds and tests against the
  engine canary, the latest stable, and the vendored floor (deduped),
  plus a nightly run that exercises the real `npx extension@<pin>` path
  end-to-end (`RUN_CLI_SMOKE=1`). A red canary cell now surfaces engine
  regressions the day they publish instead of on the next unrelated PR.
- Legacy ready-contract compatibility suite: fixtures pin the contract
  shapes older engines wrote (no `cdpPort`, no `pid`), so a 4.0.6-era
  session stays visible to browser defaulting and `resolveCdpPort`
  refuses to adopt an unrelated developer Chrome instead of probing a
  bogus port.

## 4.2.2

Agent-ergonomics release from the 4.2.1 fresh-eyes walk: the two changes
that removed nearly all friction a real MCP client hit.

- Session-aware browser default. Tools that target a running session
  (`extension_logs`, `extension_reload`, `extension_eval`,
  `extension_storage`, `extension_open`, `extension_dom_inspect`,
  `extension_list_extensions`, `extension_source_inspect`,
  `extension_wait`) no longer hard-default `browser` to a constant that
  could disagree with the session `extension_dev` actually started.
  Omitting `browser` now resolves to the active session's browser:
  in-memory registry first, then the freshest live `ready.json` contract
  on disk (dead pids ignored), then the old constant. Starting a session
  with `browser: "chrome"` and calling `extension_logs` with no args now
  just works instead of erroring about a missing chromium channel.
- Error hints speak the MCP tool surface, not the CLI. Act-verb error
  prose is rewritten before returning: `` `extension dev
  --browser=chromium --allow-control` `` becomes `extension_dev with
  { browser: "chromium", allowControl: true }`, and stray
  `--allow-control` / `--allow-eval` / `--browser=<x>` mentions become
  their tool-argument names. Result data is never touched, only
  error/hint prose. Tool descriptions now name `allowControl` /
  `allowEval` directly, so agents no longer discover the gates by
  fuzzing the schema.
- The no-channel error now names the session that IS running ("Active
  session browser(s) for this project: chrome, pass that as `browser`"),
  so an agent retargets instead of spawning a second, conflicting
  session. Same for the `extension_logs` follow miss.
- `extension_list_extensions` / `extension_source_inspect` accept
  `browser: "chromium"` (the default dev target) instead of rejecting it
  as non-Chromium.
- Tests: session-browser resolution + hint-translation suite (137 total).

## 4.2.1

`extension_build` failures no longer kill the MCP server process
(fatal-error path returned a rejected promise the server didn't catch).
CDP-dependent tools resolve the debug port from the session's ready
contract instead of assuming 9222 (plus a test-only engine pin
override, `EXTENSION_MCP_CLI_VERSION`).

## 4.2.0

Session lifecycle + determinism release. Tool count 27 -> 28.

- New tool `extension_stop`: terminates a dev/start/preview session (dev
  server AND the browser it launched) via a process-group signal with
  SIGTERM -> SIGKILL escalation. Finds the pid in the in-memory session
  registry, falling back to the `ready.json` contract when the MCP server
  restarted since the session began, and removes the stale contract so
  `extension_wait` cannot report a dead session as ready. Supports
  `all: true` to stop everything the server started.
- Sessions self-clean: dev/start/preview register an exit listener so a
  session that dies on its own is no longer reported as stoppable.
  `extension_preview` sessions are now registered (and stoppable) too.
- `extension_create` gains `parentDir`: control where the project lands
  instead of inheriting the MCP server's working directory. `nextSteps`
  now reports the full project path.
- CLI spawns are deterministic: dev/start/preview and the act tools now
  prefer the project's own `node_modules/.bin/extension`, falling back to
  `npx extension@<pinned>` where the pin derives from the vendored
  `extension-develop` version, never a floating `latest`.
- Session registry keys are path-normalized, so a stop with an absolute
  path matches a session registered with a relative one.
- Tests: registry suite now asserts against the exported `tools` array
  (the old hand-maintained mirror had drifted to 26 while the server
  registered 27); new stop + CLI-resolution suites (123 tests total).

## 4.1.2

README: restore the `@extension.dev/skill` pairing section (hands +
judgment) now that the skill is public on npm. No code changes.

## 4.1.1

README rewritten for the public npm page: Extension.js-style header
(badges, tagline, quick start), tool table updated to the full 27-tool
surface (release-promote was missing), and links to private repos or
npm-restricted packages removed. Package description tool count fixed
(26 -> 27). No code changes.

## 4.1.0

The MCP now consumes `@extension.dev/core` for all platform-auth logic
(core MIGRATION.md phase 2). No tool schema changes, no behavior changes:
the JSON-string envelopes are byte-compatible and pinned by tests.

- New dependency `@extension.dev/core` ^0.2.0: device-code login, credential
  store, and publish client now live there, shared with every other surface.
- Deleted `src/lib/credentials.ts`, `src/lib/github-device.ts`,
  `src/lib/login-flow.ts` and their migrated tests; `login`, `whoami`,
  `logout`, and `release-promote` import from core.
- `tools/publish.ts` is a thin adapter over core's `publish()`; the frozen
  PublishAuthError / PublishConfigError / PublishNetworkError / PublishError
  envelopes and the success passthrough are pinned by a new
  `publish-envelope` test.
- New `core-boundary` regression test: no file under `src/` may redefine the
  credential store or import auth primitives from anywhere but
  `@extension.dev/core`.
- CI and Release workflows pass `NPM_TOKEN` to the install step (core is
  npm-restricted until the public flip).

## 4.0.8

Tracks the `extension` 4.0.8 suite (the versioning convention: this package's
version follows the CLI suite release it pairs with). One tool was added since
3.17.0, `extension_release_promote`, bringing the surface to 27 tools.

- Bump `extension-create`, `extension-develop`, `extension-install` from
  ^3.13.5 to ^4.0.8. All consumed APIs (`extensionCreate`, `extensionBuild`,
  `extensionInstall`, `getManagedBrowsersCacheRoot`) and all CLI verbs the
  tools shell out to (`dev`, `start`, `preview`, `logs`, `eval`, `storage`,
  `reload`, `open`, `inspect`, `publish`, including `--allow-control`,
  `--allow-eval` and `--no-browser`) are unchanged in 4.x; verified
  end-to-end (create -> build -> dev ready contract -> manifest validate).
- `package.json` version now matches the published line (was a stale 0.0.1)
  and the server reports its version from `package.json` instead of a
  hardcoded string (previously stuck at 3.13.5).
- `browser-extension-manifest-fields` ^2.2.8 -> ^2.2.9.
- vitest config: resolve the extension-* test aliases from the packages'
  exports maps; 4.x dropped the CJS entry, so `require.resolve` on the bare
  specifier no longer works.

## 3.17.0

First stable release on npm. The registry previously carried only canary
builds (3.17.0-canary.*), so `npx @extension.dev/mcp` resolved a canary;
this release graduates that line to stable and becomes `latest`.

- 26 tools across scaffolding, build/dev/preview, live inspection (CDP +
  agent bridge), act tools (eval/storage/reload/open), browser management,
  and platform auth/publish.
- Claude Code integration assets (CLAUDE.md, slash commands, rules) and the
  @extension.dev/skill pairing.
- MIT license shipped; repository moved to extensiondev/mcp.

# @extension.dev/mcp, Changelog

## Unreleased, agent-bridge tools

Adds the MCP client surface for the Extension.js **agent bridge** (dev-time
observe + act + inspect). All new tools shell out to the `extension` CLI verbs
(lockstep invariant: the CLI is the single source of behavior), so they require
a recent **`extension` CLI that ships the bridge verbs** (`logs`, `eval`,
`storage`, `reload`, `open`, `inspect`, `publish`).

> ⚠️ **Release order:** publish this package ONLY after the `extension` /
> `extension-develop` suite that ships those verbs is on npm. The published CLI
> at the time of writing (`3.17.0`) does NOT have them, publishing this package
> before the suite would ship tools that fail with "unknown command". Bump the
> version + `extension-*` deps to that suite release, then publish.

New tools (22 total):

- **`extension_logs`**, read/stream logs from every extension context
  (background, content, popup/options/sidebar/devtools); filters
  `level`/`context`/`url`/`tab`/`since`, bounded `follow` window.
- **`extension_eval`**, evaluate an expression in a context (requires the dev
  session started with `--allow-eval`; MV3 service worker is CSP-gated).
- **`extension_storage`**, read/write `chrome.storage` (requires `--allow-control`).
- **`extension_reload`**, reload the extension or a tab (`--allow-control`).
- **`extension_open`**, open popup/options/sidebar (`--allow-control`).
- **`extension_dom_inspect`**, CDP-free DOM snapshot of content/page or an open
  surface (popup/options/sidebar/devtools); `withConsole` merges recent logs.
- **`extension_publish`**, publish to extension.dev and return a shareable URL
  (auth-gated; requires `EXTENSION_DEV_TOKEN`).
- **`extension_source_inspect`** gains **`deepDom`**, pierce CLOSED shadow roots
  via CDP (Chromium only).

Internal: `lib/act` (CLI shell-out helper), `lib/exec.runExtensionCli` (capture),
`lib/cdp.getClosedShadowRoots`. Test infra aligned to the workspace vitest
catalog.

## Unreleased, login (auth tools)

Adds the missing `login` flow so `extension_publish` no longer requires the user
to mint and export `EXTENSION_DEV_TOKEN` by hand. Auth stays auth-AWARE: the
token lives in a local credentials file, never in the MCP process state or logs.

New tools (25 total):

- **`extension_login`**, GitHub **device-code** flow (no local server; works
  headless). Two-phase: call with `project` (`<workspace>/<project>`) to get a
  code + URL, call again with the returned `deviceCode` to finish. On success it
  writes a project-scoped token to the credentials file. Never returns the token.
- **`extension_whoami`**, report the stored workspace/project and token expiry
  without revealing the token.
- **`extension_logout`**, delete the local credentials file.

Token resolution for publish is now `EXTENSION_DEV_TOKEN` env **>** the
credentials file (expired file tokens are ignored).

Credentials file (versioned, `0600`): `$XDG_CONFIG_HOME/extension-dev/auth.json`
(or `~/.config/...`; `%APPDATA%\extension-dev\auth.json` on Windows).

Platform endpoints this depends on (in `apps/www.extension.dev`):

- `GET /api/cli/login/config`, public GitHub OAuth client id + scope.
- `POST /api/cli/login/exchange`, trades a GitHub **user** token for a
  project-scoped access token after checking workspace membership. Modeled on
  `/api/oidc/exchange`; tokens are recorded so they stay revocable.

> ⚠️ **Ops:** the device flow requires **device flow enabled** on the GitHub
> OAuth App behind `WWW_GITHUB_OAUTH_CLIENT_ID`. Until then, `extension_login`
> can't complete and users fall back to a dashboard-minted `EXTENSION_DEV_TOKEN`.
