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

Extensions fail silently: content scripts that never inject, panels that never open, permissions that return `undefined` with no error. These tools give the agent eyes on the live browser, so it debugs from evidence instead of guessing.

- **Scaffold** from the 50+ templates behind [templates.extension.dev](https://templates.extension.dev), or add a popup, sidebar, or content script to an existing project
- **Run** the dev server with HMR in Chrome, Firefox, Edge and [every browser below](#browsers), plus Safari on macOS (no HMR yet)
- **See** the live DOM, logs from every extension context, `chrome.storage`, and the loaded-extension list
- **Act**: evaluate code in any context, trigger the action button and commands, reload the extension
- **Test**: state expectations about the running extension and get one verdict each
- **Ship**: validate the manifest cross-browser and build for production. On the [platform lane](#platform-private-alpha): share a preview link, promote a build, and submit to the stores

Built on [Extension.js](https://extension.js.org), the open source framework extension.dev sponsors.

## Watch it work

[![The agent starts the dev session, the browser opens with the extension loaded, and the agent reads its logs](https://media.extension.land/video/extension-dev/mcp/install-and-run.gif)](https://docs.extension.dev/tools/mcp#install)

## Browsers

`extension_dev` opens the extension in the browser you name.

<div align="center">

| <img alt="Chrome" src="https://media.extension.land/logos/browsers/chrome.svg" width="70"> | <img alt="Chromium" src="https://media.extension.land/logos/browsers/chromium.svg" width="70"> | <img alt="Edge" src="https://media.extension.land/logos/browsers/edge.svg" width="70"> | <img alt="Brave" src="https://media.extension.land/logos/browsers/brave.svg" width="70"> | <img alt="Opera" src="https://media.extension.land/logos/browsers/opera.svg" width="70"> | <img alt="Firefox" src="https://media.extension.land/logos/browsers/firefox.svg" width="70"> | <img alt="Safari" src="https://media.extension.land/logos/browsers/safari.svg" width="70"> |
| :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| <sup>Google Chrome</sup> | <sup>Chromium</sup> | <sup>Microsoft Edge</sup> | <sup>Brave</sup> | <sup>Opera</sup> | <sup>Mozilla Firefox</sup> | <sup>Apple Safari</sup> |

</div>

The Chromium family and Firefox get HMR, control, eval, inspect and assert (Firefox over its debugger protocol and the agent bridge, no CDP). Safari gets dev and build on macOS, no HMR and no inspect; the full list of what works there is under [Safari](https://docs.extension.dev/tools/mcp/safari). Plus Vivaldi, Yandex, Waterfox, Zen and Floorp, and any Chromium or Gecko binary by path.

## Clients

<div align="center">

| <img alt="Claude Code" src="https://media.extension.land/logos/devtools/claude-code.svg" width="70"> | <img alt="Claude Desktop" src="https://media.extension.land/logos/ai/claude.svg" width="70"> | <picture><source media="(prefers-color-scheme: dark)" srcset="https://media.extension.land/logos/devtools/cursor-dark.svg"><img alt="Cursor" src="https://media.extension.land/logos/devtools/cursor.svg" width="70"></picture> | <img alt="VS Code" src="https://media.extension.land/logos/devtools/vscode.svg" width="70"> | <picture><source media="(prefers-color-scheme: dark)" srcset="https://media.extension.land/logos/devtools/codex-dark.svg"><img alt="Codex" src="https://media.extension.land/logos/devtools/codex.svg" width="70"></picture> |
| :-: | :-: | :-: | :-: | :-: |
| <sup>Claude Code</sup> | <sup>Claude Desktop</sup> | <sup>Cursor</sup> | <sup>VS Code</sup> | <sup>Codex</sup> |

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

Or paste the `.mcp.json` block below into `.cursor/mcp.json`.

### VS Code

```bash
code --add-mcp '{"name":"extension-dev","command":"npx","args":["@extension.dev/mcp","--features=local,platform"]}'
```

Or paste it into `.vscode/mcp.json` under `servers`, with `"type": "stdio"` on the entry.

### Codex

```bash
codex mcp add extension-dev -- npx @extension.dev/mcp --features=local,platform
```

Or write it into `~/.codex/config.toml` as a `[mcp_servers.extension-dev]` table with the same `command` and `args`.

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

### Flags

- By default the server exposes the 23 of its 32 tools that work on this machine (the 9 platform tools are off). `--features=local,platform` adds the platform group. Env: `EXTENSION_DEV_FEATURES`.
- `--no-ship` refuses every call that puts something in front of other people (publish, promote, a real submit, a shared preview, a revoke). Env: `EXTENSION_DEV_NO_SHIP=1`.
- `--project <workspace>/<project>` pins the server to one project. Env: `EXTENSION_DEV_PROJECT`.

A refused call answers `E_TOOL_DISABLED` with the flag to change. Human approval for store submissions and stable promotions, the MCP annotations every tool carries, and the `<untrusted-data-ID>` fence around page-written text are described under [Server flags](https://docs.extension.dev/tools/mcp/flags).

### Telemetry

`extension_create` sends one `draft_seeded` event to PostHog at `us.i.posthog.com` after a successful scaffold (template slug, source and commit, a random per-install id, never a path or a name); nothing else sends anything. `EXTENSION_DEV_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` turns it off. The full payload is listed under [Telemetry](https://docs.extension.dev/tools/mcp/flags#telemetry).

### Pair with the skill

This server gives agents hands; [`@extension.dev/skill`](https://www.npmjs.com/package/@extension.dev/skill) gives them judgment: the cross-browser rules, silent-failure gotchas, debugging playbooks, and store checklist, in the open [Agent Skills](https://agentskills.io) format. The package also ships Claude Code rules and the four slash commands under `claude/`.

```bash
npm i -D @extension.dev/skill
mkdir -p .claude/skills && cp -R node_modules/@extension.dev/skill/skills/extension-dev .claude/skills/
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

Each check comes back `pass`, `fail` or `inconclusive`, and the run passes only when every check passed. `inconclusive` means this platform cannot cover the question today, and the check carries `settledBy` naming the evidence that would answer it: a content script passes only on a line it wrote itself, "no console errors" over a session that never built is inconclusive, and a read the session refuses (`chrome.storage` without `allowControl`) is inconclusive rather than a failure.

## Safari

A Safari dev session runs on the same bridge as every other engine: on Extension.js 4.1.28 or newer, `extension_dev` with `browser: "safari"` (macOS with Xcode) builds the app, opens it, reloads it on every save and streams its logs. Safari's MV3 background CSP blocks eval, there is no CDP or RDP path for `extension_inspect`, and opening a tab needs a safaridriver session; the limits are listed under [Safari](https://docs.extension.dev/tools/mcp/safari).

## Platform (private alpha)

The nine platform tools connect agents to [extension.dev](https://extension.dev). They stay off until the server is started with `--features=local,platform`, and sharing, publishing, promoting and submitting need a login:

```bash
npx @extension.dev/mcp login --project <workspace>/<project>
```

You approve a code at [extension.dev/device](https://extension.dev/device); no GitHub token reaches your machine, and the project-scoped token is stored locally, never returned to the agent, and lives at most 7 days. `extension_preview_web` with `share: true` uploads the build it just made and returns a link that renders those bytes in the web emulator, with its `expiresAt` and a `revokeUrl`. `extension_publish` returns the shareable URL of a build extension.dev already holds; `extension_submit` sends a built extension into store review through extension.dev, which holds your store credentials, and defaults to a dry run.

<div align="center">

| <img alt="Chrome Web Store" src="https://media.extension.land/logos/stores/chrome-web-store.png" width="70"> | <img alt="Firefox Add-ons" src="https://media.extension.land/logos/stores/firefox-addons.png" width="70"> | <img alt="Edge Add-ons" src="https://media.extension.land/logos/stores/microsoft-edge-addons.svg" width="70"> | <img alt="App Store" src="https://media.extension.land/logos/stores/app-store.svg" width="70"> |
| :-: | :-: | :-: | :-: |
| <sup>Chrome Web Store</sup> | <sup>Firefox Add-ons</sup> | <sup>Edge Add-ons</sup> | <sup>App Store</sup> |

</div>

The details, the approval flow and the batch login for several projects are under [Share a build in progress](https://docs.extension.dev/tools/mcp/platform#share-a-build-in-progress), [Publish is not submit](https://docs.extension.dev/tools/mcp/platform#publish-is-not-submit) and [Login](https://docs.extension.dev/tools/mcp/platform#login).

## Community

- Join the extension.dev [Discord](https://discord.gg/v9h2RgeTSN) for help and feedback
- Browse production-ready templates at [templates.extension.dev](https://templates.extension.dev)
- Follow the platform's public packages on [GitHub](https://github.com/extensiondev)
- Report Extension.js framework issues on [GitHub](https://github.com/extension-js/extension.js/issues)

## License

Apache-2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators. See [LICENSE](LICENSE).
