# Changelog

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
  `extension-develop` version — never a floating `latest`.
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

# @extension.dev/mcp — Changelog

## Unreleased — agent-bridge tools

Adds the MCP client surface for the Extension.js **agent bridge** (dev-time
observe + act + inspect). All new tools shell out to the `extension` CLI verbs
(lockstep invariant: the CLI is the single source of behavior), so they require
a recent **`extension` CLI that ships the bridge verbs** (`logs`, `eval`,
`storage`, `reload`, `open`, `inspect`, `publish`).

> ⚠️ **Release order:** publish this package ONLY after the `extension` /
> `extension-develop` suite that ships those verbs is on npm. The published CLI
> at the time of writing (`3.17.0`) does NOT have them — publishing this package
> before the suite would ship tools that fail with "unknown command". Bump the
> version + `extension-*` deps to that suite release, then publish.

New tools (22 total):

- **`extension_logs`** — read/stream logs from every extension context
  (background, content, popup/options/sidebar/devtools); filters
  `level`/`context`/`url`/`tab`/`since`, bounded `follow` window.
- **`extension_eval`** — evaluate an expression in a context (requires the dev
  session started with `--allow-eval`; MV3 service worker is CSP-gated).
- **`extension_storage`** — read/write `chrome.storage` (requires `--allow-control`).
- **`extension_reload`** — reload the extension or a tab (`--allow-control`).
- **`extension_open`** — open popup/options/sidebar (`--allow-control`).
- **`extension_dom_inspect`** — CDP-free DOM snapshot of content/page or an open
  surface (popup/options/sidebar/devtools); `withConsole` merges recent logs.
- **`extension_publish`** — publish to extension.dev and return a shareable URL
  (auth-gated; requires `EXTENSION_DEV_TOKEN`).
- **`extension_source_inspect`** gains **`deepDom`** — pierce CLOSED shadow roots
  via CDP (Chromium only).

Internal: `lib/act` (CLI shell-out helper), `lib/exec.runExtensionCli` (capture),
`lib/cdp.getClosedShadowRoots`. Test infra aligned to the workspace vitest
catalog.

## Unreleased — login (auth tools)

Adds the missing `login` flow so `extension_publish` no longer requires the user
to mint and export `EXTENSION_DEV_TOKEN` by hand. Auth stays auth-AWARE: the
token lives in a local credentials file, never in the MCP process state or logs.

New tools (25 total):

- **`extension_login`** — GitHub **device-code** flow (no local server; works
  headless). Two-phase: call with `project` (`<workspace>/<project>`) to get a
  code + URL, call again with the returned `deviceCode` to finish. On success it
  writes a project-scoped token to the credentials file. Never returns the token.
- **`extension_whoami`** — report the stored workspace/project and token expiry
  without revealing the token.
- **`extension_logout`** — delete the local credentials file.

Token resolution for publish is now `EXTENSION_DEV_TOKEN` env **>** the
credentials file (expired file tokens are ignored).

Credentials file (versioned, `0600`): `$XDG_CONFIG_HOME/extension-dev/auth.json`
(or `~/.config/...`; `%APPDATA%\extension-dev\auth.json` on Windows).

Platform endpoints this depends on (in `apps/www.extension.dev`):

- `GET /api/cli/login/config` — public GitHub OAuth client id + scope.
- `POST /api/cli/login/exchange` — trades a GitHub **user** token for a
  project-scoped access token after checking workspace membership. Modeled on
  `/api/oidc/exchange`; tokens are recorded so they stay revocable.

> ⚠️ **Ops:** the device flow requires **device flow enabled** on the GitHub
> OAuth App behind `WWW_GITHUB_OAUTH_CLIENT_ID`. Until then, `extension_login`
> can't complete and users fall back to a dashboard-minted `EXTENSION_DEV_TOKEN`.
