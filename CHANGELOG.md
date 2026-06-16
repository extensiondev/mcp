# Changelog

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
