[npm-version-image]: https://img.shields.io/npm/v/%40extension.dev%2Fmcp
[npm-version-url]: https://www.npmjs.com/package/@extension.dev/mcp
[action-image]: https://github.com/extensiondev/mcp/actions/workflows/ci.yml/badge.svg?branch=main
[action-url]: https://github.com/extensiondev/mcp/actions

[![Version][npm-version-image]][npm-version-url] [![workflow][action-image]][action-url]

# @extension.dev/mcp

Give your AI agent hands for browser extension development. One command connects Claude Code, Claude Desktop, Cursor, or any MCP client to 26 tools that scaffold, run, inspect, debug, and publish cross-browser extensions:

```bash
claude mcp add extension-dev npx @extension.dev/mcp
```

Extensions fail silently: content scripts that never inject, panels that never open, permissions that return `undefined` with no error. These tools give agents eyes on the live browser (DOM probes, unified logs from every context, storage access, event replay) so they debug from evidence instead of guessing. Scaffolding draws on the 60+ template catalog of the [extension.dev](https://extension.dev) platform, built on [Extension.js](https://extension.js.org).

## What's in this package

```
@extension.dev/mcp
  src/              MCP server source (26 tools)
  claude/           Claude Code integration (CLAUDE.md, slash commands, rules)
  bin/              CLI entrypoint
```

**MCP server**: programmatic bridge between AI assistants and the extension.dev platform. Imports from published npm packages:

- `extension-create`: project scaffolding
- `extension-develop`: build/dev/preview
- `extension-install`: managed browser binaries

**Claude Code integration**: drop-in instructions, slash commands, and rules for Claude Code:

- `claude/CLAUDE.md`: project-level instructions for any extension project
- `claude/commands/`: slash commands (`/extension`, `/extension-add`, `/extension-debug`, `/extension-publish`)
- `claude/rules/`: rules for extension development, cross-browser compat, and MCP tools

**Agent Skill**: the knowledge companion to this server lives in [`@extension.dev/skill`](https://npmjs.com/package/@extension.dev/skill): a portable [Agent Skills](https://agentskills.io)-format skill (SKILL.md + references) covering cross-browser rules, silent-failure gotchas, debugging playbooks, and store publishing. This server gives agents hands; the skill gives them judgment. Pair them:

```bash
mkdir -p .claude/skills && cp -R node_modules/@extension.dev/skill/skills/extension-dev .claude/skills/
```

Browser-launching tools (`dev`, `start`, `preview`) shell out to the `extension` CLI since they require the full browser launcher infrastructure.

## Setup

### Claude Code

```bash
claude mcp add extension-dev npx @extension.dev/mcp
```

### Claude Desktop / .mcp.json

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

### Claude Code integration (manual)

Copy the Claude Code rules and commands into any extension project:

```bash
# Rules (how Claude understands your project)
cp node_modules/@extension.dev/mcp/claude/CLAUDE.md ~/my-extension/.claude/CLAUDE.md

# Slash commands
mkdir -p ~/my-extension/.claude/commands
cp node_modules/@extension.dev/mcp/claude/commands/*.md ~/my-extension/.claude/commands/
```

## Tools

| Tier | Tool                            | Integration                     | Description                       |
| ---- | ------------------------------- | ------------------------------- | --------------------------------- |
| 1    | `extension_create`              | `extensionCreate()`             | Scaffold from a template          |
| 1    | `extension_list_templates`      | native                          | Browse 60+ templates              |
| 1    | `extension_build`               | `extensionBuild()`              | Build for production              |
| 1    | `extension_dev`                 | CLI spawn                       | Dev server with HMR               |
| 1    | `extension_start`               | CLI spawn                       | Build + preview                   |
| 1    | `extension_preview`             | CLI spawn                       | Preview production build          |
| 2    | `extension_get_template_source` | native                          | Read template source files        |
| 2    | `extension_manifest_validate`   | native                          | Cross-browser manifest validation |
| 2    | `extension_inspect`             | native                          | Build output analysis             |
| 2    | `extension_source_inspect`      | CDP WebSocket                   | Live DOM inspection               |
| 2    | `extension_dom_inspect`         | agent bridge                    | CDP-free DOM snapshot             |
| 2    | `extension_list_extensions`     | CDP WebSocket                   | List loaded extensions (Chromium) |
| 2    | `extension_logs`                | agent bridge                    | Stream logs from every context    |
| 2    | `extension_wait`                | native                          | Poll ready.json contract          |
| 2    | `extension_add_feature`         | native                          | Add sidebar/popup/content script  |
| act  | `extension_eval`                | agent bridge                    | Eval in a context (`--allow-eval`) |
| act  | `extension_storage`             | agent bridge                    | Read/write `chrome.storage`       |
| act  | `extension_reload`              | agent bridge                    | Reload extension or tab           |
| act  | `extension_open`                | agent bridge                    | Open surface / trigger `action`,`command` |
| 3    | `extension_install_browser`     | `extensionInstall()`            | Install managed browser           |
| 3    | `extension_list_browsers`       | `getManagedBrowsersCacheRoot()` | List managed browsers             |
| 3    | `extension_detect_browsers`     | native                          | System browser detection          |
| auth | `extension_login`               | platform                        | GitHub device-code → stored token |
| auth | `extension_whoami`              | native                          | Show stored login (no token)      |
| auth | `extension_logout`              | native                          | Remove stored credentials         |
| auth | `extension_publish`             | platform                        | Publish to extension.dev (token)  |

## Development

```bash
pnpm install
pnpm compile    # Build with rslib
pnpm test       # Run tests
pnpm start      # Start MCP server
```

### Publishing

```bash
NPM_TOKEN=<token> pnpm publish
```

Uses `prepublishOnly` to run tests and compile before publishing.

## The extension.dev open source stack

| Package | Use it to |
| --- | --- |
| [`@extension.dev/skill`](https://github.com/extensiondev/skill) | Teach agents the cross-browser rules and silent-failure gotchas |
| [`deploy`](https://extension.dev) | Ship to Chrome, Firefox, and Edge stores from CI |
| [`@extension.dev/artifact-integrity`](https://github.com/extensiondev/artifact-integrity) | Gate releases on artifact verification |
| [`@extension.dev/compiler`](https://github.com/extensiondev/compiler) | Build extensions in the browser with esbuild-wasm |
| [`@extension.dev/core`](https://github.com/extensiondev/core) | Authenticate and publish to the extension.dev platform |

All of it rides on [Extension.js](https://github.com/extension-js/extension.js), the open-source cross-browser extension framework.

## License

MIT
