[npm-version-image]: https://img.shields.io/npm/v/%40extension.dev%2Fmcp.svg?color=26FFB8
[npm-version-url]: https://www.npmjs.com/package/@extension.dev/mcp
[npm-downloads-image]: https://img.shields.io/npm/dm/%40extension.dev%2Fmcp.svg?color=26FFB8
[npm-downloads-url]: https://www.npmjs.com/package/@extension.dev/mcp
[discord-image]: https://img.shields.io/discord/1253608412890271755?label=Discord&logo=discord&style=flat&color=26FFB8
[discord-url]: https://discord.gg/v9h2RgeTSN

# @extension.dev/mcp [![Version][npm-version-image]][npm-version-url] [![Downloads][npm-downloads-image]][npm-downloads-url] [![Discord][discord-image]][discord-url]

> Give your AI agent hands for browser extension development. 30 MCP tools that scaffold, run, inspect, debug, and publish cross-browser extensions.

<img alt="Logo" align="right" src="https://media.extension.land/brand/extension-dev/logo-dock.png" width="15.5%" />

```bash
claude mcp add extension-dev npx @extension.dev/mcp
```

Works with Claude Code, Claude Desktop, Cursor, and any MCP client.

[extension.dev](https://extension.dev) · [Documentation](https://extension.js.org) · [Templates](https://templates.extension.dev) · [Examples](https://github.com/extension-js/examples) · [Discord](https://discord.gg/v9h2RgeTSN)

## Why an MCP server for extensions

Extensions fail silently: content scripts that never inject, panels that never open, permissions that return `undefined` with no error. An agent editing files blind will happily "fix" all of them without noticing none of them work.

These tools give agents eyes on the live browser, so they debug from evidence instead of guessing:

- **Scaffold** from the 60+ template catalog behind [templates.extension.dev](https://templates.extension.dev), or add a popup, sidebar, or content script to an existing project
- **Run** the dev server with HMR in Chrome, Edge, Firefox, Safari, Brave, Opera, Vivaldi, Yandex, Waterfox, LibreWolf, or any Chromium- or Gecko-based binary, no build config
- **See** the live DOM, unified logs from every extension context, `chrome.storage` contents, and the loaded-extension list
- **Act**: evaluate code in any context, trigger the action button and commands, reload the extension, replay events
- **Ship**: validate the manifest cross-browser, build for production, publish a shareable preview, and promote builds to release channels headlessly

Built on [Extension.js](https://extension.js.org), the open-source cross-browser extension framework.

## Setup

### Claude Code

```bash
claude mcp add extension-dev npx @extension.dev/mcp
```

Or install it as a plugin — the MCP server plus the `/extension`, `/extension-add`, `/extension-debug`, and `/extension-publish` commands in one step:

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
| build | `extension_list_templates` | Browse 60+ templates |
| build | `extension_get_template_source` | Read template source files |
| build | `extension_add_feature` | Add sidebar/popup/content script |
| build | `extension_build` | Build for production |
| run | `extension_dev` | Dev server with HMR |
| run | `extension_start` | Build + preview |
| run | `extension_preview` | Preview the production build |
| run | `extension_wait` | Poll the dev-server ready contract |
| run | `extension_stop` | Stop a dev/start/preview session (server + browser) |
| see | `extension_manifest_validate` | Cross-browser manifest validation |
| see | `extension_inspect` | Build output analysis |
| see | `extension_source_inspect` | Live DOM inspection (CDP) |
| see | `extension_dom_inspect` | CDP-free DOM snapshot |
| see | `extension_list_extensions` | List loaded extensions (Chromium) |
| see | `extension_logs` | Stream logs from every context |
| see | `extension_doctor` | Diagnose the dev session leg by leg (ready contract, ports, token, executor, browser) |
| act | `extension_eval` | Evaluate in a context (needs `allowEval: true` on `extension_dev`) |
| act | `extension_storage` | Read/write `chrome.storage` |
| act | `extension_reload` | Reload extension or tab |
| act | `extension_open` | Open a surface / trigger `action`, `command` |
| browsers | `extension_install_browser` | Install a managed browser binary |
| browsers | `extension_uninstall_browser` | Remove a managed browser binary |
| browsers | `extension_list_browsers` | List managed browsers |
| browsers | `extension_detect_browsers` | Detect system browsers |
| platform | `extension_login` | GitHub device-code login, stored token |
| platform | `extension_whoami` | Show the stored login (never the token) |
| platform | `extension_logout` | Remove stored credentials |
| platform | `extension_publish` | Publish a shareable preview to extension.dev |
| platform | `extension_release_promote` | Promote a build to a release channel, headless |
| platform | `extension_deploy` | Submit to the Chrome, Firefox, and Edge stores (wraps `deploy`) |

Browser-launching tools (`dev`, `start`, `preview`) shell out to the `extension` CLI — the project's own `node_modules/.bin/extension` when present, otherwise `npx extension@<pinned>` at the version this package is verified against; everything else runs in-process.

## From preview to store

The platform tools connect agents to [extension.dev](https://extension.dev): `extension_login` runs a GitHub device-code flow and stores a project-scoped token locally (never returned to the agent), `extension_publish` turns a build into a shareable preview URL, and `extension_release_promote` promotes a tested build to a release channel from CI or an agent session, no browser required. `extension_deploy` submits the built `.zip` to the Chrome Web Store, Edge Add-ons, and Firefox AMO by driving the standalone [`deploy`](https://extension.dev) CLI — it defaults to a dry run and reads store credentials from the environment or a `.env.submit` file, never from tool arguments.

## The extension.dev stack

| Package | Use it to |
| --- | --- |
| [`@extension.dev/skill`](https://www.npmjs.com/package/@extension.dev/skill) | Teach AI agents the judgment half: cross-browser rules, gotchas, playbooks |
| [`deploy`](https://extension.dev) | Ship to Chrome, Firefox, and Edge stores from CI |

All of it rides on [Extension.js](https://github.com/extension-js/extension.js), the open-source cross-browser extension framework.

## Community

- Join the [Discord](https://discord.gg/v9h2RgeTSN) for help and feedback
- Browse production-ready [examples](https://github.com/extension-js/examples)
- Report Extension.js framework issues on [GitHub](https://github.com/extension-js/extension.js/issues)

## License

MIT (c) Cezar Augusto and the extension.dev collaborators
