[npm-version-image]: https://img.shields.io/npm/v/%40extension.dev%2Fmcp.svg?color=26FFB8
[npm-version-url]: https://www.npmjs.com/package/@extension.dev/mcp
[npm-downloads-image]: https://img.shields.io/npm/dm/%40extension.dev%2Fmcp.svg?color=26FFB8
[npm-downloads-url]: https://www.npmjs.com/package/@extension.dev/mcp
[discord-image]: https://img.shields.io/discord/1253608412890271755?label=Discord&logo=discord&style=flat&color=26FFB8
[discord-url]: https://discord.gg/v9h2RgeTSN

# @extension.dev/mcp [![Version][npm-version-image]][npm-version-url] [![Downloads][npm-downloads-image]][npm-downloads-url] [![Discord][discord-image]][discord-url]

> Give your AI agent hands for browser extension development. 28 MCP tools that scaffold, run, inspect, debug, and publish cross-browser extensions.

<img alt="Logo" align="right" src="https://media.extension.land/brand/extension-dev/logo-dock.png" width="15.5%" />

```bash
claude mcp add extension-dev npx @extension.dev/mcp
```

Works with Claude Code, Claude Desktop, Cursor, and any MCP client.

[extension.dev](https://extension.dev) · [Documentation](https://extension.js.org) · [Templates](https://templates.extension.dev) · [Examples](https://github.com/extension-js/examples) · [Discord](https://discord.gg/v9h2RgeTSN)

## Why an MCP server for extensions

Extensions fail silently: content scripts that never inject, panels that never open, permissions that return `undefined` with no error. An agent editing files blind will happily "fix" all of them without noticing none of them work.

These tools give agents eyes on the live browser, so they debug from evidence instead of guessing:

- **Scaffold** from the 50+ template catalog behind [templates.extension.dev](https://templates.extension.dev), or add a popup, sidebar, or content script to an existing project
- **Run** the dev server with HMR in Chrome, Edge, Firefox, Brave, Opera, Vivaldi, Yandex, Waterfox, LibreWolf, or any Chromium- or Gecko-based binary, plus Safari on macOS (no HMR yet), no build config
- **See** the live DOM, unified logs from every extension context, `chrome.storage` contents, and the loaded-extension list
- **Act**: evaluate code in any context, trigger the action button and commands, reload the extension, replay events
- **Ship**: validate the manifest cross-browser, build for production, publish a shareable preview, and promote builds to release channels headlessly

Built on [Extension.js](https://extension.js.org), the open-source cross-browser extension framework.

## Clients

<div align="center">

| <img alt="Claude Code" src="https://media.extension.land/logos/devtools/claude-code.svg" width="70"> | <img alt="Claude Desktop" src="https://media.extension.land/logos/ai/claude.svg" width="70"> | <picture><source media="(prefers-color-scheme: dark)" srcset="https://media.extension.land/logos/devtools/cursor-dark.svg"><img alt="Cursor" src="https://media.extension.land/logos/devtools/cursor.svg" width="70"></picture> |
| :-: | :-: | :-: |
| Claude Code | Claude Desktop | Cursor |

</div>

## Setup

### Claude Code

```bash
claude mcp add extension-dev npx @extension.dev/mcp
```

Or install it as a plugin, the MCP server plus the `/extension`, `/extension-add`, `/extension-debug`, and `/extension-publish` commands in one step:

```
/plugin marketplace add extensiondev/mcp
/plugin install extension-mcp@extensiondev-mcp
```

### Cursor

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=extension-dev&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyJAZXh0ZW5zaW9uLmRldi9tY3AiXX0%3D)

### Claude Desktop / `.mcp.json`

```json
{
  "mcpServers": {
    "extension-dev": {
      "command": "npx",
      "args": ["@extension.dev/mcp"]
    }
  }
}
```

### Pair with the skill

This server gives agents hands; [`@extension.dev/skill`](https://www.npmjs.com/package/@extension.dev/skill) gives them judgment: the cross-browser rules, silent-failure gotchas, debugging playbooks, and store checklist, packaged in the open [Agent Skills](https://agentskills.io) format. With both installed, agents know to verify against the live browser instead of guessing, and these tools make that a one-call operation.

```bash
npm i -D @extension.dev/skill
mkdir -p .claude/skills && cp -R node_modules/@extension.dev/skill/skills/extension-dev .claude/skills/
```

### Claude Code project integration

The package ships drop-in instructions, slash commands, and rules for extension projects:

```bash
# Rules (how Claude understands your project)
cp node_modules/@extension.dev/mcp/claude/CLAUDE.md ~/my-extension/.claude/CLAUDE.md

# Slash commands (/extension, /extension-add, /extension-debug, /extension-publish)
mkdir -p ~/my-extension/.claude/commands
cp node_modules/@extension.dev/mcp/claude/commands/*.md ~/my-extension/.claude/commands/
```

## Tools

| Tier | Tool | Description |
| ---- | ---- | ----------- |
| build | `extension_create` | Scaffold from a template |
| build | `extension_templates` | Browse 50+ templates (`list`) and read one's source (`source`) |
| build | `extension_add_feature` | Add sidebar/popup/content script |
| build | `extension_build` | Build for production |
| run | `extension_dev` | Dev server with HMR |
| run | `extension_start` | Build + launch the production build (`build: false` launches the existing dist) |
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
| act | `extension_eval` | Evaluate in a context (needs `allowEval: true` on `extension_dev`) |
| act | `extension_storage` | Read/write `chrome.storage` |
| act | `extension_reload` | Reload extension or tab |
| act | `extension_open` | Open a surface / trigger `action`, `command` |
| browsers | `extension_browsers` | Detect, list, install, and uninstall browsers |
| platform | `extension_auth` | Device login at extension.dev, plus login status and logout |
| platform | `extension_preview_web` | Render a build in the web emulator, and share it as a link |
| platform | `extension_shares` | List every link you have shared, and revoke one permanently |
| platform | `extension_publish` | Publish a shareable preview to extension.dev |
| platform | `extension_release_promote` | Promote a build to a release channel, headless |
| platform | `extension_submit` | Submit for store review: Chrome, Firefox, Edge, Safari, through extension.dev |
| platform | `extension_release_status` | Read release channels, recent builds, and store submission and review state |

Browser-launching tools (`dev`, `start`) shell out to the `extension` CLI, the project's own `node_modules/.bin/extension` when present, otherwise `npx extension@<pinned>` at the version this package is verified against; everything else runs in-process.

## Sharing a build in progress

An unpacked extension is unusually hard to hand to someone: the only way to look at a colleague's work-in-progress has been to take their zip and run untrusted code with real browser permissions on your own machine. `extension_preview_web` with `share: true` uploads the `dist/` it just built and returns a link that renders those exact bytes in the emulator. Whoever opens it installs nothing and signs in to nothing, which is what lets a designer, a PM, or a reviewer into the loop at all. Those bytes run in an isolated sandbox origin or they do not run at all: preview refuses a shared build rather than serving it in its own renderer. Sharing needs auth (`extension_auth` or `EXTENSION_DEV_TOKEN`), the link lives 30 days, and `DELETE`ing the returned `revokeUrl` with the same token kills it early. Re-sharing an unchanged build returns that same link rather than a second one, and only a revoked link is replaced by a different one, because revocation is permanent: the address is burned and never resolves again. That makes `revokeUrl` the handle to the link you just made, so every share is also appended to `.extension.dev/shared-previews.json` in the project (gitignored) so it survives losing the tool output. The upload holds up to 2,000 files and about 64MB of text, or roughly 48MB when the build is mostly images, fonts or wasm, which travel base64-encoded. Without `share`, the tool returns a local-only deep link and uploads nothing.

`extension_shares` is the other half of that: it lists every link the token has shared, live and dead, with the `previewUrl` and `revokeUrl` of each, and revokes one by `artifactId` or by pasting any of its URLs. Pass `projectPath` and it reconciles the platform's answer with the project's own record, so a link shared from another machine shows up as `remoteOnly` and a record with nothing behind it any more shows up under `localOnly`. It never rewrites the local file.

That is a different job from shipping. Use `share` for the build you are holding right now; use `extension_publish` and `extension_release_promote` below for builds your CI has released.

## From preview to store

The platform tools connect agents to [extension.dev](https://extension.dev): `extension_auth` runs extension.dev's own device flow (you approve the code at [extension.dev/device](https://extension.dev/device), and GitHub is federated server-side, so no GitHub token ever reaches your machine) and stores a project-scoped token locally (never returned to the agent), `extension_publish` turns a build your project has already published into a shareable URL, and `extension_release_promote` promotes a tested build to a release channel from CI or an agent session, no browser required. `extension_submit` submits a built extension to the Chrome Web Store, Edge Add-ons, Firefox AMO, and the App Store for Safari through extension.dev, which holds your store credentials and dispatches the release from your project's mirror CI, it defaults to a dry run and store credentials are never tool arguments. The two verbs are not interchangeable: `extension_publish` pushes to the extension.dev platform, `extension_submit` sends the build into a store's review queue, which is irreversible. After a real submission, `extension_release_status` reads the recorded outcome, per-store credential health, and review state from the project's public registry, so agents and CI can answer "was it approved?" without a console visit. Access tokens live at most 7 days; CI pipelines re-mint them from the console's Access tokens page.

## The extension.dev stack

| Package | Use it to |
| --- | --- |
| [`@extension.dev/skill`](https://www.npmjs.com/package/@extension.dev/skill) | Teach AI agents the judgment half: cross-browser rules, gotchas, playbooks |
| [`@extension.dev/artifact-integrity`](https://www.npmjs.com/package/@extension.dev/artifact-integrity) | Verify extension artifacts and gate CI on tampered bytes before they ship |

All of it rides on [Extension.js](https://github.com/extension-js/extension.js), the open-source cross-browser extension framework.

## Community

- Join the extension.dev [Discord](https://discord.gg/v9h2RgeTSN) for help and feedback
- Browse production-ready templates at [templates.extension.dev](https://templates.extension.dev)
- Follow the platform's public packages on [GitHub](https://github.com/extensiondev)
- Report Extension.js framework issues on [GitHub](https://github.com/extension-js/extension.js/issues)

## License

Apache-2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators. See [LICENSE](LICENSE).
