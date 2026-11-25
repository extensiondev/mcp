[npm-version-image]: https://img.shields.io/npm/v/%40extension.dev%2Fmcp.svg?labelColor=f4f4f5&color=1c1c1e
[npm-version-url]: https://www.npmjs.com/package/@extension.dev/mcp
[npm-downloads-image]: https://img.shields.io/npm/dm/%40extension.dev%2Fmcp.svg?labelColor=f4f4f5&color=1c1c1e
[npm-downloads-url]: https://www.npmjs.com/package/@extension.dev/mcp
[discord-image]: https://img.shields.io/discord/1253608412890271755?label=Discord&logo=discord&style=flat&labelColor=f4f4f5&color=1c1c1e&logoColor=1c1c1e
[discord-url]: https://discord.gg/BRqbPDfPxb

# extension.dev MCP [![Version][npm-version-image]][npm-version-url] [![Downloads][npm-downloads-image]][npm-downloads-url] [![Discord][discord-image]][discord-url]

> Build, run, debug, test and ship Chrome, Firefox, Edge and Safari extensions from your AI agent.

<img alt="Chrome, Edge, Firefox and Safari" align="right" src="https://raw.githubusercontent.com/extensiondev/mcp/main/docs/browsers.svg" width="34%" />

extension.dev MCP is the MCP server for building browser extensions in Claude Code, Cursor, VS Code, Codex and any MCP client. Your agent creates an extension, runs it, proves it works and ships it to four stores.

[Documentation](https://docs.extension.dev/tools/mcp) · [Tools](#tools) · [Skill](https://www.npmjs.com/package/@extension.dev/skill) · [Changelog](CHANGELOG.md) · [Troubleshooting](#troubleshooting) · [Discord](https://discord.gg/BRqbPDfPxb)

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

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=extension-dev&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBleHRlbnNpb24uZGV2L21jcCIsIi0tZmVhdHVyZXM9bG9jYWwscGxhdGZvcm0iXX0%3D) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%7B%22name%22%3A%22extension-dev%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40extension.dev%2Fmcp%22%2C%22--features%3Dlocal%2Cplatform%22%5D%7D)

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

The local tools need no account; the platform tools, on with `--features=local,platform`, ask for a login the first time they reach extension.dev. Add `extras` (`--features=local,platform,extras`) to list `extension_theme_verify` and `extension_network`.

## Your first prompt

**Build it and prove it works**

> Create a Chrome and Firefox extension that highlights external links, run it, and prove the content script injected.

The agent scaffolds from a template, starts the dev session, a browser opens with the extension loaded, and `extension_assert` answers with a verdict instead of a guess.

**Then ship it**

> Submit this build to the Chrome Web Store and Firefox Add-ons as a dry run and tell me what is missing.

`extension_submit` defaults to a dry run, so nothing goes into review until a workspace owner approves the real submit.

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

Extensions fail silently, with content scripts that never inject and panels that never open, so these tools give the agent eyes on the live browser.

- **Ship**: validate the manifest cross-browser, build, share a preview, promote, submit
- **Scaffold** from 50+ [templates](https://templates.extension.dev), or add a popup, sidebar or content script
- **Run** the dev server with HMR in [every browser below](#browsers)
- **See** the live DOM, logs from every context, `chrome.storage`, the loaded extensions
- **Act**: evaluate code in any context, trigger the action button and commands, reload
- **Test**: `extension_assert` answers `pass`, `fail` or `inconclusive`, the last naming the evidence that would settle it

Every engine command runs the project's own engine when it has one, else the version this server pins ([Engine pinning](https://docs.extension.dev/tools/mcp#engine-pinning-for-scaffolds)).

## Supported AI agents

| | Works in | How it connects |
| --- | --- | --- |
| <img src="https://raw.githubusercontent.com/extensiondev/mcp/main/docs/logos/claude.svg" width="24" height="24" alt=""> | **Claude Code** | `claude mcp add` or the `extension-dev` plugin, [Install](#install) |
| <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/extensiondev/mcp/main/docs/logos/cursor-dark.svg"><img src="https://raw.githubusercontent.com/extensiondev/mcp/main/docs/logos/cursor-light.svg" width="24" height="24" alt=""></picture> | **Cursor** | One-click link, [Install](#install) |
| <img src="https://raw.githubusercontent.com/extensiondev/mcp/main/docs/logos/vscode.svg" width="24" height="24" alt=""> | **VS Code** | One-click link for Copilot agent mode, [Install](#install) |
| <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/extensiondev/mcp/main/docs/logos/openai-dark.svg"><img src="https://raw.githubusercontent.com/extensiondev/mcp/main/docs/logos/openai-light.svg" width="24" height="24" alt=""></picture> | **Codex** | `codex mcp add` or `~/.codex/config.toml`, [Install in your client](https://docs.extension.dev/tools/mcp/clients) |

Any other MCP client takes the same `.mcp.json` block.

## Supported frameworks

| | Build a browser extension with | Ask your agent |
| --- | --- | --- |
| <img src="https://raw.githubusercontent.com/extensiondev/mcp/main/docs/logos/react.svg" width="24" height="24" alt=""> | **React** (11 templates) | "Create a React side panel extension and run it in Chrome" |
| <img src="https://raw.githubusercontent.com/extensiondev/mcp/main/docs/logos/preact.svg" width="24" height="24" alt=""> | **Preact** (6 templates) | "Build a Preact new tab page with a router and test it in Firefox" |
| <img src="https://raw.githubusercontent.com/extensiondev/mcp/main/docs/logos/vue.svg" width="24" height="24" alt=""> | **Vue** (6 templates) | "Make a Vue popup that saves notes to chrome.storage" |
| <img src="https://raw.githubusercontent.com/extensiondev/mcp/main/docs/logos/svelte.svg" width="24" height="24" alt=""> | **Svelte** (6 templates) | "Scaffold a Svelte content script that highlights links" |
| <img src="https://raw.githubusercontent.com/extensiondev/mcp/main/docs/logos/typescript.svg" width="24" height="24" alt=""> | **TypeScript** (11 templates) | "Start a TypeScript DevTools panel that stores data in SQLite" |
| <img src="https://raw.githubusercontent.com/extensiondev/mcp/main/docs/logos/javascript.svg" width="24" height="24" alt=""> | **JavaScript** (26 templates) | "Add a popup to my plain JavaScript extension and ship it to Edge" |

Every template builds for Chrome, Edge and Firefox, and the same project ships to Safari through the [App Store lane](https://docs.extension.dev/tools/mcp/safari).

## Requirements

- Node 22.12 or later.
- A Chromium or Firefox browser, or `extension_browsers` installs one.
- macOS with Xcode only for a local Safari session; the App Store lane needs no Mac.
- An extension.dev login only for the platform tools.

## Browsers

<p align="center"><img alt="Google Chrome" src="https://media.extension.land/logos/browsers/chrome.svg" width="56"> &nbsp; <img alt="Chromium" src="https://media.extension.land/logos/browsers/chromium.svg" width="56"> &nbsp; <img alt="Microsoft Edge" src="https://media.extension.land/logos/browsers/edge.svg" width="56"> &nbsp; <img alt="Brave" src="https://media.extension.land/logos/browsers/brave.svg" width="56"> &nbsp; <img alt="Opera" src="https://media.extension.land/logos/browsers/opera.svg" width="56"> &nbsp; <img alt="Mozilla Firefox" src="https://media.extension.land/logos/browsers/firefox.svg" width="56"> &nbsp; <img alt="Apple Safari" src="https://media.extension.land/logos/browsers/safari.svg" width="56"></p>

`extension_dev` opens the extension in the browser you name. The Chromium family and Firefox get HMR, control, eval, inspect and assert, and so does any Chromium or Gecko binary by path. On macOS with Xcode, `browser: "safari"` builds the app, opens it, reloads it on every save and streams its logs; no eval, no `extension_inspect`, limits under [Safari](https://docs.extension.dev/tools/mcp/safari).

## Security

- **Local by default.** Every local tool runs on your machine. The control channel (`extension_storage`, `extension_reload`, `extension_open`, `extension_dom_snapshot`) is same machine, same user, on unless `extension_dev` is called with `allowControl: false`.
- **The eval gate.** `extension_eval` stays off until `extension_dev` is called with `allowEval: true`. A session never grows a gate on a second call: call `extension_dev` again with `replace: true` ([Session gates](https://docs.extension.dev/tools/mcp#session-gates)).

  <details><summary>Input that needs no gate</summary>

  `extension_element` clicks, fills, reads and waits for one element, and sends trusted mouse and keyboard input (move, press, release, type, key, scroll) that pages read as `isTrusted: true`, over the debug port with no gate, since it runs no caller code.

  </details>

- **What leaves the machine.** Nothing until you ask, and [docs/network.json](docs/network.json) lists every host, what each receives and how to turn it off. A platform tool is answered by extension.dev's hosted lane at `mcp.extension.dev`, which gets a credential that lasts ten minutes, never the login. `--no-ship` refuses every call that puts something in front of other people.

  <details><summary>The full list</summary>

  Nothing until you ask. Of the local tools, `extension_docs_search` sends the query text to www.extension.dev with no login, the template tools read the catalog at registry.extension.land and the template files at raw.githubusercontent.com, api.github.com and codeload.github.com, and `extension_browsers_install` downloads a browser. A platform tool is answered by extension.dev's hosted lane at `mcp.extension.dev`: this server exchanges the stored login at www.extension.dev for a credential that lasts ten minutes and sends the lane that credential, the tool's arguments and the project ref, never the login, a file path or the `api` override. A store check or a listing sync also sends what it read from the project (the text of `STORE.md`, the icon and screenshot sizes and digests, the git HEAD); a listing image is uploaded to www.extension.dev only when the listing write needs it. A shared preview uploads the build it just made, a project created from a folder uploads that folder, a capture sync uploads the capture files, and a login stores a project-scoped token locally. Signing in and out, a create and its device approval, a preview, a build download, a capture sync and a share create run on this machine. `--no-ship` refuses every call that puts something in front of other people.

  </details>

- **Approvals stay human.** A real submit, a channel promotion and a share revoke answer `approval-required`; a workspace owner approves the exact act on extension.dev, the call is repeated with the returned `approvalId`, and the server never approves anything itself. `extension_submit_check` carries the reads and the asks under `readOnlyHint: true`; `extension_submit` carries the act.
- **Untrusted text** from pages comes back inside an `<untrusted-data-ID>` fence, and every tool carries MCP annotations.
- **Report a vulnerability.** Use [private vulnerability reporting](https://github.com/extensiondev/mcp/security/advisories/new) on this repository, not a public issue. It reaches the maintainer directly.

## Telemetry

`extension_create` sends one `draft_seeded` event to `us.i.posthog.com` after a scaffold (template slug, source and commit, a random per-process id, never a path or a name), and the platform tools send a per-install id header. `EXTENSION_DEV_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` stops both ([payload](https://docs.extension.dev/tools/mcp/flags#how-it-works)).

## Hosted server

`https://mcp.extension.dev/mcp` serves the platform reads and promotions over Streamable HTTP: a client connects with the URL alone, signs in at www.extension.dev through OAuth, and gets `extension_workspace`, `extension_project_create`, `extension_builds` (reads), `extension_builds_act`, `extension_release_status`, `extension_release_promote` and `extension_auth` (status only). Local tools, publish, submit and share links stay on the stdio server.

```bash
claude mcp add --transport http extension-dev https://mcp.extension.dev/mcp
```

## Flags

| Flag | Environment variable | Default | Effect |
| --- | --- | --- | --- |
| `--features=<groups>` | `EXTENSION_DEV_FEATURES` | `local` | `local,platform` adds the platform group; `extras`, off unless named, adds the theme check and the network stubs; a group named alone lists only its tools |
| `--no-ship` | `EXTENSION_DEV_NO_SHIP=1` | off | Refuses publish, promote, a real submit, a store act (the listing sync included), a shared preview, a share create or revoke |
| `--project <workspace>/<project>` | `EXTENSION_DEV_PROJECT` | unset | Refuses any call that names another project |
| none | `EXTENSION_DEV_TOKEN` | unset | An [access token](https://docs.extension.dev/tools/access-tokens) in place of the device login, for CI |
| none | `EXTENSION_DEV_NO_AUTO_OPEN=1` | off | Never opens the approval page in the default browser |
| none | `EXTENSION_DEV_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` | off | Turns off the `draft_seeded` event and the per-install id header |
| none | `EXTENSION_MCP_CLI_VERSION` | this release's pin | The engine version run when the project has none of its own |
| none | `EXTENSION_MCP_ENGINE_DIR` or `EXTENSION_MCP_ENGINE_BIN` | unset | Runs every engine command from a compiled engine checkout or one bin file |
| none | `EXTENSION_DEV_API_URL` | `https://www.extension.dev` | The extension.dev platform the platform tools and docs search call, an extension.dev host or a local development server |
| none | `EXTENSION_HEADLESS=1` | off | Launches every browser headless unless a call passes `headless: false` |
| none | `EXTENSION_BROWSER_FLAGS` | unset | Extra flags for every browser the engine starts; a `--headless` here counts as `EXTENSION_HEADLESS=1` |
| none | `EXT_BROWSERS_CACHE_DIR` | per-user cache | The folder that holds the managed browsers |
| none | `EXTENSION_MCP_SESSION_DIR` | system temporary folder | The folder for the running sessions' state files |
| none | `EXTENSION_TRY_DIR` | system temporary folder | The folder where `extension_try` unpacks a published build |
| none | `EXTENSION_ISOLATED_DIR` | system temporary folder | The folder for isolated runs |
| none | `EXTENSION_KEEP_SOCKET_PROCESS=1` | off | On Linux, keeps Firefox's socket process with an engine older than 4.3.0 |

Internal overrides for development and tests, not for normal use: `EXTENSION_DEV_CONSOLE_URL`, `EXTENSION_DEV_INSPECT_URL`, `EXTENSION_DEV_PREVIEW_URL`, `EXTENSION_DEV_USERLAND_URL`, `EXTENSION_DEV_REGISTRY_URL`, `EXTENSION_DEV_FORWARD_URL`, `EXTENSION_MEDIA_ORIGIN`, `EXTENSION_DEV_POSTHOG_HOST`, `EXTENSION_DEV_POSTHOG_KEY`, `EXTENSION_DEV_POSTHOG_KEY_NONPRODUCTION`, `EXTENSION_TEMPLATES_CATALOG_URL`, `EXTENSION_TEMPLATES_COMMIT`, `EXTENSION_DEV_APPROVAL_GATE`, `EXTENSION_MCP_BUILD_ID`, `EXTENSION_OUTPUT`, `EXTENSION_CREATE_TEMPLATE_REF`.

`login`, `logout`, `whoami` and `release promote` run headless; see [Server flags](https://docs.extension.dev/tools/mcp/flags).

## Tools

The local group scaffolds, builds, runs, inspects, drives and asserts; the platform group logs in, shares, promotes, submits, reads builds, releases and approvals, and runs a published build with `extension_try`; the extras group, off unless named, verifies a Chrome theme and stubs network responses. Every tool has a page under the [tool reference](https://docs.extension.dev/tools/mcp#reference), generated from the schema the server registers, with its inputs, whether it only reads, the gate it needs and a prompt that reaches for it.

## Prompts and resources

The server lists four prompts, starting points a client shows in its prompt menu. Each one tells the agent which tools to call, in order, and to call a change done only after seeing it work in a real browser.

| Prompt | Arguments | What it starts |
| --- | --- | --- |
| `create-extension` | `idea`, `browser` (optional) | A new extension from a template, run and proven in a browser |
| `verify-change` | `change`, `projectPath` and `browser` (optional) | A verdict on an edit, read from a live session |
| `debug-extension` | `symptom`, `projectPath` and `browser` (optional) | The cause of a content script, popup or background script that does nothing |
| `prepare-store-submission` | `stores` and `projectPath` (optional) | A store checklist that stops before anything goes to review |

It also serves four read-only documents from its own package, never from your project or the network.

| Resource | What it is |
| --- | --- |
| `extension-dev://reference/tools` | Every tool with its inputs, types and defaults |
| `extension-dev://reference/store-md` | The fields a `STORE.md` may carry |
| `extension-dev://reference/security` | The [Security](#security) section of this file |
| `extension-dev://changelog/current` | The [changelog](CHANGELOG.md) section of the running version |

## Pair with the skill

This server gives agents hands; [`@extension.dev/skill`](https://www.npmjs.com/package/@extension.dev/skill) gives them judgment: cross-browser rules, silent-failure gotchas, debugging playbooks and the store checklist.

```bash
npx skills add extensiondev/skill
```

## Questions

**How do I publish a Chrome extension from Claude Code or Cursor?**

Add the server with the line under [Install](#install), then ask the agent to submit the build. `extension_submit` defaults to a dry run, and a real submit waits for a workspace owner to approve it on extension.dev.

**Can an AI agent submit to the App Store without a Mac?**

Yes. The Safari lane signs with keys the platform holds encrypted at rest; only a local Safari session needs macOS with Xcode.

**Does it need an account?**

The local tools need none. The platform tools ask for an extension.dev login the first time they reach extension.dev.

## Troubleshooting

Every refusal carries an error code and a hint (`error.hint`) naming what to change or the next call. The five most common:

- **`E_TOOL_DISABLED`**: the tool's group is off, or the call reaches outside this machine in no-ship mode. Add the group the hint names (`platform` or `extras`) to `--features`, or drop `--no-ship`, in the client's config, then call again.
- **`approval-required`**: have a workspace owner approve the act at the link, then repeat the call with the same arguments and the returned `approvalId`.
- **`E_AUTH_REQUIRED`** or **`E_AUTH_EXPIRED`**: the login lives at most 7 days. Run `extension_auth` (`action: "login"`, `project: "<workspace>/<project>"`), then call again.
- **`E_NO_SESSION`**: nothing is running. Start `extension_dev`, then `extension_wait` for ready.
- **`extension_eval` refused**: the session started without the gate. Call `extension_dev` again with `allowEval: true` and `replace: true`; reads need no eval.

`extension_doctor` names the broken leg of a session. After a new version lands a tool may answer `E_SERVER_STALE`: run `/mcp`, pick `extension-dev`, and call again. More under [When it fails](https://docs.extension.dev/tools/mcp#when-it-fails).

## Community

Help and feedback on [Discord](https://discord.gg/BRqbPDfPxb); templates at [templates.extension.dev](https://templates.extension.dev); issues at [extensiondev/mcp](https://github.com/extensiondev/mcp/issues).

## License

Apache-2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators. See [LICENSE](LICENSE).
