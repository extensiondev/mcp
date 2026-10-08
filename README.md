[npm-version-image]: https://img.shields.io/npm/v/%40extension.dev%2Fmcp.svg?color=26FFB8
[npm-version-url]: https://www.npmjs.com/package/@extension.dev/mcp
[npm-downloads-image]: https://img.shields.io/npm/dm/%40extension.dev%2Fmcp.svg?color=26FFB8
[npm-downloads-url]: https://www.npmjs.com/package/@extension.dev/mcp
[discord-image]: https://img.shields.io/discord/1253608412890271755?label=Discord&logo=discord&style=flat&color=26FFB8
[discord-url]: https://discord.gg/v9h2RgeTSN

# @extension.dev/mcp [![Version][npm-version-image]][npm-version-url] [![Downloads][npm-downloads-image]][npm-downloads-url] [![Discord][discord-image]][discord-url]

> Give your AI agent hands for browser extension development. 32 MCP tools that scaffold, run, inspect, debug, test, and build cross-browser extensions on your machine, plus a platform lane (private alpha) to share and publish them.

<img alt="Logo" align="right" src="https://media.extension.land/brand/extension-dev/logo-dock.png" width="20.7%" />

```bash
claude mcp add extension-dev npx @extension.dev/mcp
```

Works with Claude Code, Claude Desktop, Cursor, and any MCP client.

[extension.dev](https://extension.dev) · [Docs](https://docs.extension.dev/tools/mcp) · [Templates](https://templates.extension.dev) · [Discord](https://discord.gg/v9h2RgeTSN)

## Why an MCP server for extensions

Extensions fail silently: content scripts that never inject, panels that never open, permissions that return `undefined` with no error. An agent editing files blind will "fix" all of them without noticing none of them work. These tools give the agent eyes on the live browser, so it debugs from evidence instead of guessing.

- **Scaffold** from the 50+ templates behind [templates.extension.dev](https://templates.extension.dev), or add a popup, sidebar, or content script to an existing project
- **Run** the dev server with HMR in Chrome, Edge, Firefox, Brave, Opera, Vivaldi, Yandex, Waterfox, Zen, Floorp, or any Chromium- or Gecko-based binary, plus Safari on macOS (no HMR yet), no build config
- **See** the live DOM, logs from every extension context, `chrome.storage`, and the loaded-extension list
- **Act**: evaluate code in any context, trigger the action button and commands, reload the extension, replay events
- **Test**: state expectations about the running extension and get one verdict each
- **Ship**: validate the manifest cross-browser and build for production. On the [platform lane](#platform-private-alpha): share a preview link, promote a build to a release channel, and submit to the stores (a stable promotion asks a human first)

Built on [Extension.js](https://extension.js.org), the open source framework extension.dev sponsors.

## Watch it work

[![The agent starts the dev session, the browser opens with the extension loaded, and the agent reads its logs](https://media.extension.land/video/extension-dev/mcp/install-and-run.gif)](https://docs.extension.dev/tools/mcp#install)

## Clients

<div align="center">

| <img alt="Claude Code" src="https://media.extension.land/logos/devtools/claude-code.svg" width="70"> | <img alt="Claude Desktop" src="https://media.extension.land/logos/ai/claude.svg" width="70"> | <picture><source media="(prefers-color-scheme: dark)" srcset="https://media.extension.land/logos/devtools/cursor-dark.svg"><img alt="Cursor" src="https://media.extension.land/logos/devtools/cursor.svg" width="70"></picture> |
| :-: | :-: | :-: |
| Claude Code | Claude Desktop | Cursor |

</div>

## Setup

<!-- setup:start (generated from src/clients, run pnpm readme:clients) -->

### Claude Code

```bash
claude mcp add extension-dev -- npx @extension.dev/mcp --features=local,platform
```

Or install it as a plugin, the MCP server plus the `/extension`, `/extension-add`, `/extension-debug`, and `/extension-publish` commands in one step:

```
/plugin marketplace add extensiondev/mcp
/plugin install extension-mcp@extensiondev-mcp
```

### Cursor

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=extension-dev&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyJAZXh0ZW5zaW9uLmRldi9tY3AiLCItLWZlYXR1cmVzPWxvY2FsLHBsYXRmb3JtIl19)

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "extension-dev": {
      "command": "npx",
      "args": [
        "@extension.dev/mcp",
        "--features=local,platform"
      ]
    }
  }
}
```

### VS Code (Also GitHub Copilot)

```bash
code --add-mcp '{"name":"extension-dev","command":"npx","args":["@extension.dev/mcp","--features=local,platform"]}'
```

`.vscode/mcp.json`:

```json
{
  "servers": {
    "extension-dev": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "@extension.dev/mcp",
        "--features=local,platform"
      ]
    }
  }
}
```

### Codex

```bash
codex mcp add extension-dev -- npx @extension.dev/mcp --features=local,platform
```

`~/.codex/config.toml`:

```toml
[mcp_servers.extension-dev]
command = "npx"
args = ["@extension.dev/mcp", "--features=local,platform"]
```

### Other clients (Claude Desktop and .mcp.json)

`.mcp.json`:

```json
{
  "mcpServers": {
    "extension-dev": {
      "command": "npx",
      "args": [
        "@extension.dev/mcp",
        "--features=local,platform"
      ]
    }
  }
}
```

<!-- setup:end -->

### What the agent can reach

Two tool groups, three flags, each also an environment variable:

- By default the server exposes the 23 of its 32 tools that work on this machine (the 9 platform tools are off): create, run, inspect, test, build, and docs search. `--features=local,platform` adds the platform group (account, share, release, and store tools, described under [Platform](#platform-private-alpha)); `--features=platform` exposes only that group. Env: `EXTENSION_DEV_FEATURES`.
- `--no-ship` refuses the calls that put something in front of other people: `extension_publish`, `extension_release_promote`, `extension_submit` with `dryRun: false`, `extension_preview_web` with `share: true`, and a share revoke. Dry runs, share listing, login, and workspace or project creation still work. Env: `EXTENSION_DEV_NO_SHIP=1`.
- `--project <workspace>/<project>` pins the server to one project, however many logins this machine holds; a call naming another project is refused. Env: `EXTENSION_DEV_PROJECT`.

A refused call answers `E_TOOL_DISABLED` with the flag to change.

A real store submission, a promotion to stable, and a share revoke also wait for a person by default: the first call answers `approval-required` with a link on extension.dev, a workspace member approves exactly that action (a store submission needs a workspace owner), and the same call with the returned `approvalId` runs it once. `EXTENSION_DEV_APPROVAL_GATE=1` extends this to every promotion; `EXTENSION_DEV_APPROVAL_GATE=0` turns it off.

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so clients can auto-approve reads and ask before the rest.

Answers that can carry text a web page or an extension wrote (logs, DOM, eval results, storage, titles, runtime errors) fence it between `<untrusted-data-ID>` and `</untrusted-data-ID>`, with a fresh random `ID` per call in `untrusted.boundary`. The page cannot predict the ID or close the fence early, and the JSON still parses to the same fields. A fence is a signal to the model, not a gate: pair it with `--no-ship` when the agent reads pages you do not trust.

```json
{
  "mcpServers": {
    "extension-dev": {
      "command": "npx",
      "args": ["@extension.dev/mcp", "--features=local,platform", "--no-ship"]
    }
  }
}
```

### Telemetry

`extension_create` sends one event after a successful scaffold, `draft_seeded`, to PostHog at `https://us.i.posthog.com/capture/` with a public write-only project key. It carries the template slug, the template source (`template`, `fork` or `blank-init`), the template commit it resolved, a random per-install session id, the environment, and the fixed names `source`, `entry` and `emitted_from`; never a path, a project name, a user name, an address or anything read from your files. No other tool sends anything. Set `EXTENSION_DEV_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` in the server's environment to turn it off.

### Pair with the skill

This server gives agents hands; [`@extension.dev/skill`](https://www.npmjs.com/package/@extension.dev/skill) gives them judgment: the cross-browser rules, silent-failure gotchas, debugging playbooks, and store checklist, in the open [Agent Skills](https://agentskills.io) format.

```bash
npm i -D @extension.dev/skill
mkdir -p .claude/skills && cp -R node_modules/@extension.dev/skill/skills/extension-dev .claude/skills/
```

The package also ships Claude Code rules and the four slash commands for extension projects:

```bash
cp node_modules/@extension.dev/mcp/claude/CLAUDE.md ~/my-extension/.claude/CLAUDE.md
mkdir -p ~/my-extension/.claude/commands
cp node_modules/@extension.dev/mcp/claude/commands/*.md ~/my-extension/.claude/commands/
```

## Tools

On by default, the 23 that work on this machine:

| Tier | Tool | Description |
| ---- | ---- | ----------- |
| build | `extension_create` | Scaffold from a template |
| build | `extension_templates` | Browse 50+ templates (`list`) and read one's source (`source`) |
| build | `extension_docs_search` | Search the Extension.js and extension.dev docs by keyword |
| build | `extension_add_feature` | Plan a sidebar, popup, or content script for an existing project |
| build | `extension_build` | Build for production |
| run | `extension_dev` | Dev server with HMR |
| run | `extension_start` | Build + launch the production build (`build: false` launches the existing dist; `outputPath` launches any prebuilt unpacked directory) |
| run | `extension_wait` | Poll the dev-server ready contract |
| run | `extension_stop` | Stop a dev/start/preview session (server + browser) |
| see | `extension_manifest_validate` | Cross-browser manifest validation |
| see | `extension_analyze` | Static analysis of the built extension on disk |
| see | `extension_inspect` | Deep live inspection of a running extension (closed shadow roots, probes) |
| see | `extension_dom_snapshot` | Shallow DOM snapshot of a chosen tab or extension surface over the agent bridge |
| see | `extension_list_extensions` | List loaded extensions (Chromium and Firefox) |
| see | `extension_logs` | Stream logs from every context |
| see | `extension_doctor` | Diagnose the dev session leg by leg (ready contract, ports, token, executor, browser) |
| see | `extension_theme_verify` | Verify a Chrome theme manifest against the colors Chrome actually paints |
| test | `extension_assert` | State expectations about a running extension and get one verdict each: pass, fail, or inconclusive |
| act | `extension_eval` | Evaluate in a context (needs `allowEval: true` on `extension_dev`) |
| act | `extension_storage` | Read/write `chrome.storage` |
| act | `extension_reload` | Reload extension or tab |
| act | `extension_open` | Open a surface (popup, options, sidebar, devtools panel, override pages) / trigger `action`, `command` |
| browsers | `extension_browsers` | Detect, list, install, and uninstall browsers |

On with `--features=local,platform`, the 9 that reach the extension.dev platform (private alpha):

| Tier | Tool | Description |
| ---- | ---- | ----------- |
| platform | `extension_auth` | Device login at extension.dev for one project or a list of them, plus login status and logout |
| platform | `extension_workspace_create` | Create an extension.dev workspace, headless, via device approval; the approver becomes its owner |
| platform | `extension_project_create` | Create the extension.dev project for a built extension, or several under one approval, headless, via device approval |
| platform | `extension_preview_web` | Render a build in the web emulator, and share it as a link |
| platform | `extension_shares` | List every link you have shared, and revoke one permanently |
| platform | `extension_publish` | Mint a shareable link for a build extension.dev already holds (nothing is uploaded) |
| platform | `extension_release_promote` | Promote a build to a release channel, headless |
| platform | `extension_submit` | Submit for store review: Chrome, Firefox, Edge and Safari, through extension.dev |
| platform | `extension_release_status` | Read release channels, recent builds, and store submission and review state |

`extension_dev` is the only tool that unlocks the act tools: `allowControl: true` for `extension_storage`, `extension_reload`, `extension_open` and `extension_dom_snapshot`; `allowEval: true` for `extension_eval` (it implies `allowControl`). A session started without a gate does not grow one on a second call: call `extension_dev` again with the flag you need plus `replace: true`, which stops the first session.

Browser-launching tools (`dev`, `start`) shell out to the `extension` CLI, the project's own `node_modules/.bin/extension` when present, otherwise `npx extension@<pinned>` at the version this package is verified against; build, doctor, eval, storage, reload, open, dom_snapshot and assert spawn that CLI too, and the rest runs in-process.

## Asserting instead of guessing

Every other tool hands back a reading. `extension_assert` states the expectation and returns the verdict.

[![Five expectations go in, five verdicts come back: pass, fail, or inconclusive with what would settle it](https://media.extension.land/video/extension-dev/mcp/assert-verdicts.gif)](https://docs.extension.dev/tools/mcp#run-and-debug)

```jsonc
{
  "projectPath": "/path/to/extension",
  "expect": [
    { "assert": "background-worker-booted" },
    { "assert": "surface-rendered", "surface": "popup", "selector": "[data-testid=root]" },
    { "assert": "storage-key-present", "key": "settings", "area": "local" },
    { "assert": "console-errors-empty", "context": ["background", "popup"] },
    { "assert": "content-script-injected", "url": "https://shop.example/cart" }
  ]
}
```

Each check comes back `pass`, `fail` or `inconclusive`, and the run passes only when every check passed. `inconclusive` means this platform cannot cover the question today, and the check carries `settledBy` naming the evidence that would answer it. A content script's execution is not observable from outside its isolated world, so `content-script-injected` passes only on a line the script itself wrote, never on a declared match alone. "No console errors" over a session that never built is inconclusive, because zero errors and zero events are the same number. A read the platform refuses, such as `chrome.storage` on a session started without `allowControl`, is inconclusive rather than a failure.

## Safari

A Safari dev session runs on the same bridge as every other engine. On Extension.js 4.1.28 or newer, `extension_dev` with `browser: "safari"` (macOS with Xcode) builds the app, opens it, and, once you enable the extension in Safari > Settings > Extensions, reloads it on every save and streams its background and content lines into the session log. With `allowControl` or `allowEval`, `extension_storage`, `extension_reload`, `extension_dom_snapshot` (by tab id), `extension_open` for surfaces, `extension_logs`, and the assertions `content-script-injected` (on a content line at the url), `background-worker-booted`, `storage-key-present` and `console-errors-empty` work against it.

The limits: Safari's MV3 background CSP blocks eval, so `extension_eval` in `background` fails. Safari has no CDP or RDP, so `extension_inspect` has no Safari path; `surface-rendered` reads the surface through the relay and can pass or fail. `extension_open` with `url` and `extension_eval` with context `page` ride a safaridriver automation session, which the dev session opens on Extension.js 4.1.32 or newer when Safari > Settings > Developer > "Allow remote automation and external agents" is on (`ready.json` records `webdriverPort` and `webdriverSessionId`; `extension_doctor` shows it as a `safari-window` leg, `skip` with the engine's own reason when it could not open one). Without that session `extension_open` cannot open a tab on Safari, so open the page by hand, and `extension_eval` in `content` or `page` needs that tab already open at the url. Apple's own MCP server in `safaridriver --mcp` has page-level tools and no extension-aware tool, and runs beside a Safari dev session; `extension_browsers` reports whether the machine's safaridriver has `--mcp`.

## Platform (private alpha)

The platform tools connect agents to [extension.dev](https://extension.dev). The platform is in private alpha: these nine tools stay off until the server is started with `--features=local,platform` (or `EXTENSION_DEV_FEATURES=local,platform`), and sharing, publishing, promoting and submitting need a login.

### Sign in and pin a project

```bash
npx @extension.dev/mcp login --project <workspace>/<project>
```

Or call `extension_auth` with `action: "login"`: you approve a code at [extension.dev/device](https://extension.dev/device), GitHub is federated server-side so no GitHub token reaches your machine, and the project-scoped token is stored locally, never returned to the agent, and lives at most 7 days. CI re-mints from the console's Access tokens page, or sets `EXTENSION_DEV_TOKEN`. Add `--project <workspace>/<project>` to the server's arguments so that server only ever acts on that project; the console's Connect dialog fills both in.

### Share a build in progress

[![The agent shares the build it just made and the link opens in the web emulator with nothing installed](https://media.extension.land/video/extension-dev/mcp/share-a-build.gif)](https://docs.extension.dev/tools/mcp#preview-and-share)

`extension_preview_web` with `share: true` uploads the `dist/` it just built and returns a link that renders those exact bytes in the emulator: whoever opens it installs nothing and signs in to nothing, the bytes run in an isolated sandbox origin or not at all, and the link also serves the build as a zip, so it hands over the built code. The link lives for the workspace plan's share window (30 days on Free, longer on Pro) and the answer carries its exact `expiresAt` and a `revokeUrl`; re-sharing an unchanged build returns the same link, a revoke is permanent, and every share is appended to `.extension.dev/shared-previews.json` in the project (gitignored). The upload holds up to 2,000 files and about 64MB of text, roughly 48MB when the build is mostly images, fonts or wasm. Without `share`, the tool returns a local-only deep link and uploads nothing. `extension_shares` lists every link the token has shared, live and dead, with each `previewUrl` and `revokeUrl`, revokes one by `artifactId` or any of its URLs, and with `projectPath` reconciles against the project's own record (`remoteOnly`, `localOnly`) without rewriting it.

### Publish, promote, submit

[![A dry-run store submission comes back with one verdict per store and dispatches nothing](https://media.extension.land/video/extension-dev/mcp/submit-dry-run.gif)](https://docs.extension.dev/tools/mcp#publish-is-not-submit)

Two verbs, not interchangeable. `extension_publish` returns the shareable URL of a build extension.dev already holds, nothing is uploaded: the public page for a public project, a time-limited `?share=` link for a private one. `extension_submit` sends a built extension into store review (Chrome Web Store, Edge Add-ons, Firefox AMO and the App Store for Safari) through extension.dev, which holds your store credentials and dispatches from your project's mirror CI; credentials are never tool arguments. It defaults to a dry run, and `dryRun: false` is irreversible and needs the workspace owner's token. Safari and the App Store are one paid lane, so a free workspace is refused there and the other three stores are unaffected.

`extension_release_promote` moves a release channel to a tested build, headless, from CI or an agent session. After a real submission, `extension_release_status` reads the recorded outcome, per-store credential health, and review state from the project's public registry, so agents and CI can answer "was it approved?" without a console visit.

### Several projects under one approval

`extension_project_create` takes `projects`, a list of `{ project, repo }` entries in one workspace, in place of `project` and `repo`: one approval page lists every name, each project is created by its own request, and each one's 7-day token is stored as that project's login. `extension_auth` with `action: "login"` takes `projects`, a list of `<workspace>/<project>` names of existing projects, and stores one token per project, which is also how logins that expire together are renewed. Both lists: one workspace, 1 to 20 names, each by its exact slug (lowercase letters and digits joined by single dashes, at most 48 characters), none twice. A create list is capped at 10, the platform's limit per approving account per hour, and a longer list is refused, never split. While projects remain the answer is `status: "creating"` with the same `deviceCode` to call again, always with one row per project, so a refusal on one never hides the others. A server pinned with `--project` refuses a list that names any other project.

## The extension.dev stack

| Package | Use it to |
| --- | --- |
| [`@extension.dev/skill`](https://www.npmjs.com/package/@extension.dev/skill) | Teach AI agents the judgment half: cross-browser rules, gotchas, playbooks |
| [`@extension.dev/artifact-integrity`](https://www.npmjs.com/package/@extension.dev/artifact-integrity) | Check an artifact against a declared SHA-256 and gate CI on the result|

All of it rides on [Extension.js](https://github.com/extension-js/extension.js), the open-source cross-browser extension framework.

## Community

- Join the extension.dev [Discord](https://discord.gg/v9h2RgeTSN) for help and feedback
- Browse production-ready templates at [templates.extension.dev](https://templates.extension.dev)
- Follow the platform's public packages on [GitHub](https://github.com/extensiondev)
- Report Extension.js framework issues on [GitHub](https://github.com/extension-js/extension.js/issues)

## License

Apache-2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators. See [LICENSE](LICENSE).
