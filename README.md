[npm-version-image]: https://img.shields.io/npm/v/%40extension.dev%2Fmcp.svg?color=26FFB8
[npm-version-url]: https://www.npmjs.com/package/@extension.dev/mcp
[npm-downloads-image]: https://img.shields.io/npm/dm/%40extension.dev%2Fmcp.svg?color=26FFB8
[npm-downloads-url]: https://www.npmjs.com/package/@extension.dev/mcp
[discord-image]: https://img.shields.io/discord/1253608412890271755?label=Discord&logo=discord&style=flat&color=26FFB8
[discord-url]: https://discord.gg/v9h2RgeTSN

# @extension.dev/mcp [![Version][npm-version-image]][npm-version-url] [![Downloads][npm-downloads-image]][npm-downloads-url] [![Discord][discord-image]][discord-url]

> Ship browser extensions to four stores from your AI agent: create, run, test and submit to Chrome, Firefox, Edge and Safari.

<img alt="Logo" align="right" src="https://media.extension.land/brand/extension-dev/logo-dock.png" width="20.7%" />

Extension.js is the framework you run. extension.dev is where it ships. This server covers both: the local tools run Extension.js on your machine, and the platform lane takes the build the rest of the way to the stores.

[Docs](https://docs.extension.dev/tools/mcp) · [Tools](#tools) · [Skill](https://www.npmjs.com/package/@extension.dev/skill) · [Changelog](CHANGELOG.md) · [Troubleshooting](#troubleshooting) · [Discord](https://discord.gg/v9h2RgeTSN)

## Install

<!-- setup:start (generated from src/clients, run pnpm readme:clients) -->

```bash
claude mcp add extension-dev -- npx -y @extension.dev/mcp --features=local,platform
```

Or install the `extension-dev` plugin, the MCP server pinned to one published version plus the `browser-extension` skill, in one step:

```
/plugin marketplace add extensiondev/skill
/plugin install extension-dev@extensiondev
```

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=extension-dev&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyJAZXh0ZW5zaW9uLmRldi9tY3AiLCItLWZlYXR1cmVzPWxvY2FsLHBsYXRmb3JtIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%7B%22name%22%3A%22extension-dev%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22%40extension.dev%2Fmcp%22%2C%22--features%3Dlocal%2Cplatform%22%5D%7D)

Other clients take the same server as `.mcp.json`; every client's block, with a local-only form, is on [Install in your client](https://docs.extension.dev/tools/mcp/clients).

```json
{
  "mcpServers": {
    "extension-dev": {
      "command": "npx",
      "args": [
        "-y",
        "@extension.dev/mcp",
        "--features=local,platform"
      ]
    }
  }
}
```

<!-- setup:end -->

The local tools need no account; the platform tools, on with `--features=local,platform`, ask for a login the first time they reach extension.dev.

## Your first prompt

> Create a Chrome and Firefox extension that highlights external links, run it, and prove the content script injected.

The agent scaffolds from a template, starts the dev session, a browser opens with the extension loaded, and `extension_assert` answers with a verdict instead of a guess. Then:

> Submit this build to the Chrome Web Store and Firefox Add-ons as a dry run and tell me what is missing.

## Ship to four stores

<p align="center"><img alt="Chrome Web Store" src="https://media.extension.land/logos/stores/chrome-web-store.png" width="64"> &nbsp; <img alt="Firefox Add-ons" src="https://media.extension.land/logos/stores/firefox-addons.png" width="64"> &nbsp; <img alt="Edge Add-ons" src="https://media.extension.land/logos/stores/microsoft-edge-addons.svg" width="64"> &nbsp; <img alt="App Store" src="https://media.extension.land/logos/stores/app-store.svg" width="64"></p>

`extension_submit` sends a built extension into review at the four stores through extension.dev, which holds your store credentials. It defaults to a dry run, and a real submit waits for a workspace owner to approve that exact act on extension.dev: the server never submits or publishes on its own. Reaching the App Store needs no Mac: the Safari lane signs with keys the platform holds encrypted at rest, under the same approval.

The platform tools need a login once. You approve a code at [extension.dev/device](https://extension.dev/device); the project-scoped token stays on this machine, is never returned to the agent, and lives at most 7 days. No project yet? Request access at [extension.dev](https://extension.dev).

```bash
npx -y @extension.dev/mcp login --project <workspace>/<project>
```

Details under [Platform tools](https://docs.extension.dev/tools/mcp/platform).

## Watch it work

[![Asked to run the extension, the agent starts the dev session and Chrome opens with it loaded, from a real Claude Code session](https://media.extension.land/video/extension-dev/mcp/run.gif)](https://docs.extension.dev/tools/mcp/dev)

## What it does

Extensions fail silently: content scripts that never inject, panels that never open. These tools give the agent eyes on the live browser.

- **Ship**: validate the manifest cross-browser, build, share a preview, promote, submit
- **Scaffold** from 50+ [templates](https://templates.extension.dev), or add a popup, sidebar or content script
- **Run** the dev server with HMR in [every browser below](#browsers)
- **See** the live DOM, logs from every context, `chrome.storage`, the loaded extensions
- **Act**: evaluate code in any context, trigger the action button and commands, reload
- **Test**: `extension_assert` answers `pass`, `fail` or `inconclusive`, the last naming the evidence that would settle it

Built on [Extension.js](https://extension.js.org), the open source framework extension.dev sponsors. Every engine command runs the project's own `extension` when the project has one, else the version this server pins ([Engine pinning](https://docs.extension.dev/tools/mcp#engine-pinning-for-scaffolds)).

## Requirements

- Node 22.12 or later.
- A Chromium or Firefox browser, or `extension_browsers` installs one.
- macOS with Xcode only for a local Safari session; the App Store lane needs no Mac.
- An extension.dev login only for the platform tools.

## Browsers

<p align="center"><img alt="Google Chrome" src="https://media.extension.land/logos/browsers/chrome.svg" width="56"> &nbsp; <img alt="Chromium" src="https://media.extension.land/logos/browsers/chromium.svg" width="56"> &nbsp; <img alt="Microsoft Edge" src="https://media.extension.land/logos/browsers/edge.svg" width="56"> &nbsp; <img alt="Brave" src="https://media.extension.land/logos/browsers/brave.svg" width="56"> &nbsp; <img alt="Opera" src="https://media.extension.land/logos/browsers/opera.svg" width="56"> &nbsp; <img alt="Mozilla Firefox" src="https://media.extension.land/logos/browsers/firefox.svg" width="56"> &nbsp; <img alt="Apple Safari" src="https://media.extension.land/logos/browsers/safari.svg" width="56"></p>

`extension_dev` opens the extension in the browser you name. The Chromium family and Firefox get HMR, control, eval, inspect and assert, and so does any Chromium or Gecko binary by path. On macOS with Xcode, `browser: "safari"` builds the app, opens it, reloads it on every save and streams its logs; no eval, no `extension_inspect`, limits under [Safari](https://docs.extension.dev/tools/mcp/safari).

## Security

- **Local by default.** Every local tool runs Extension.js on your machine. The control channel (`extension_storage`, `extension_reload`, `extension_open`, `extension_dom_snapshot`) is same machine, same user, on unless `extension_dev` is called with `allowControl: false`.
- **The eval gate.** `extension_eval` stays off until `extension_dev` is called with `allowEval: true`. `extension_element` clicks, fills, reads and waits for one element over the debug port with no gate, since it runs no caller code. A session never grows a gate on a second call: call `extension_dev` again with `replace: true`.
- **What leaves the machine.** Nothing until you ask: a shared preview uploads the build it just made, a submit sends the build to extension.dev, a login stores a project-scoped token locally. `--no-ship` refuses every call that puts something in front of other people.
- **Approvals stay human.** A real submit, a channel promotion and a share revoke answer `approval-required`; a workspace owner approves the exact act on extension.dev, the call is repeated with the returned `approvalId`, and the server never approves anything itself. `extension_submit_check` carries the reads and the asks under `readOnlyHint: true`; `extension_submit` carries the act.
- **Untrusted text** from pages comes back inside an `<untrusted-data-ID>` fence, and every tool carries MCP annotations.

## Telemetry

`extension_create` sends one `draft_seeded` event to `us.i.posthog.com` after a scaffold (template slug, source and commit, a random per-process id, never a path or a name), and the platform tools send a per-install id header. `EXTENSION_DEV_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` stops both ([payload](https://docs.extension.dev/tools/mcp/flags#telemetry)).

## Hosted server

`https://mcp.extension.dev/mcp` serves the platform reads and promotions over Streamable HTTP: a client connects with the URL alone, signs in at www.extension.dev through OAuth, and gets `extension_workspace`, `extension_project_create`, `extension_builds`, `extension_release_status`, `extension_release_promote` and `extension_auth` (status only). Local tools, publish, submit and share links stay on the stdio server.

```bash
claude mcp add --transport http extension-dev https://mcp.extension.dev/mcp
```

## Flags

| Flag | Environment variable | Default | Effect |
| --- | --- | --- | --- |
| `--features=<groups>` | `EXTENSION_DEV_FEATURES` | `local` | `local,platform` adds the platform group; `platform` lists only those |
| `--no-ship` | `EXTENSION_DEV_NO_SHIP=1` | off | Refuses publish, promote, a real submit, a shared preview, a share create or revoke |
| `--project <workspace>/<project>` | `EXTENSION_DEV_PROJECT` | unset | Refuses any call that names another project |
| none | `EXTENSION_DEV_TOKEN` | unset | An [access token](https://docs.extension.dev/tools/access-tokens) in place of the device login, for CI |
| none | `EXTENSION_DEV_NO_AUTO_OPEN=1` | off | Never opens the approval page in the default browser |
| none | `EXTENSION_DEV_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` | off | Turns off the `draft_seeded` event and the per-install id header |
| none | `EXTENSION_MCP_CLI_VERSION` | this release's pin | The Extension.js version run when the project has no engine of its own |
| none | `EXTENSION_MCP_ENGINE_DIR` or `EXTENSION_MCP_ENGINE_BIN` | unset | Runs every engine command from a compiled Extension.js checkout or one bin file |

`login`, `logout`, `whoami` and `release promote` run headless; see [Server flags](https://docs.extension.dev/tools/mcp/flags).

## Tools

The local group scaffolds, builds, runs, inspects, drives and asserts; the platform group logs in, shares, promotes, submits and reads builds, releases and approvals. Every tool has a page under the [tool reference](https://docs.extension.dev/tools/mcp#reference), generated from the schema the server registers, with its inputs, whether it only reads, the gate it needs and a prompt that reaches for it.

## Pair with the skill

This server gives agents hands; [`@extension.dev/skill`](https://www.npmjs.com/package/@extension.dev/skill) gives them judgment: cross-browser rules, silent-failure gotchas, debugging playbooks and the store checklist.

```bash
npx skills add extensiondev/skill
```

## Troubleshooting

Every refusal carries a `hint` naming the next call. The five most common:

- **`E_TOOL_DISABLED`**: the tool's group is off, or the call reaches outside this machine in no-ship mode. Add `platform` to `--features`, or drop `--no-ship`, in the client's config, then call again.
- **`approval-required`**: have a workspace owner approve the act at the link, then repeat the call with the same arguments and the returned `approvalId`.
- **`E_AUTH_REQUIRED`** or **`E_AUTH_EXPIRED`**: the login lives at most 7 days. Run `extension_auth` (`action: "login"`, `project: "<workspace>/<project>"`), then call again.
- **`E_NO_SESSION`**: nothing is running. Start `extension_dev`, then `extension_wait` for ready.
- **`extension_eval` refused**: the session started without the gate. Call `extension_dev` again with `allowEval: true` and `replace: true`; reads need no eval.

`extension_doctor` names the broken leg of a session. After a new version lands a tool may answer `E_SERVER_STALE`: run `/mcp`, pick `extension-dev`, and call again. More under [When it fails](https://docs.extension.dev/tools/mcp#when-it-fails).

## Community

Help and feedback on [Discord](https://discord.gg/v9h2RgeTSN); templates at [templates.extension.dev](https://templates.extension.dev); Extension.js framework issues at [extension-js/extension.js](https://github.com/extension-js/extension.js/issues).

## License

Apache-2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators. See [LICENSE](LICENSE).
