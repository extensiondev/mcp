# extension.dev, Claude Code Integration

Drop-in instructions, rules, and example prompts for building browser extensions with the [extension.dev](https://extension.dev) platform using Claude Code.

**Looking for the MCP server?** See the root [`README.md`](../README.md).

## What's here

```
claude/
  CLAUDE.md               Drop-in Claude Code instructions for any extension project
  ARCHITECTURE.md         How the template, CLAUDE.md, and MCP layers connect
  commands/
    extension.md          /extension: create, dev, build, add features, debug
    extension-add.md      /extension-add: add sidebar, popup, content script, etc.
    extension-debug.md    /extension-debug: live DOM/console inspection
    extension-publish.md  /extension-publish: store submission prep
  rules/
    extension-dev.md      Core rules: project structure, manifest, commands
    cross-browser.md      Cross-browser manifest field mapping
    mcp-tools.md          Full MCP tool specification and design doc
  examples/
    create-extension.md   Example prompt: scaffold and customize an extension
    add-sidebar.md        Example prompt: add a sidebar panel to an existing extension
```

## Quick start

Copy `CLAUDE.md` and slash commands into any extension project:

```bash
# Rules (how Claude understands your project)
cp node_modules/@extension.dev/mcp/claude/CLAUDE.md ~/my-extension/.claude/CLAUDE.md

# Slash commands (what you can type)
mkdir -p ~/my-extension/.claude/commands
cp node_modules/@extension.dev/mcp/claude/commands/*.md ~/my-extension/.claude/commands/
```

### Slash commands

| Command                                  | What it does                                           |
| ---------------------------------------- | ------------------------------------------------------ |
| `/extension create my-ext react sidebar` | Scaffold a new extension from templates                |
| `/extension dev`                         | Start dev server with HMR                              |
| `/extension build`                       | Build for production                                   |
| `/extension-add sidebar react`           | Add a feature surface to existing project              |
| `/extension-debug https://example.com`   | Inspect live DOM, console, content scripts             |
| `/extension-publish both`                | Prepare zips and checklist for Chrome + Firefox stores |

Claude Code will automatically pick up the instructions and know how to:

- Browse the template catalog via `templates-meta.json`
- Scaffold extensions with `npx extension create --template=<slug>`
- Read example source from the catalog to learn patterns
- Work with the `manifest.json` cross-browser format
- Run dev/build/preview commands
- Handle Chromium vs Firefox differences

## How it connects to the examples repo

The [examples repo](https://github.com/extension-js/examples) publishes `templates-meta.json` as a nightly release asset. This file is the single source of truth for:

- **CLAUDE.md**, references it so Claude knows all available templates
- **MCP tools**, `extension_list_templates` fetches and queries it at runtime
- **`extension create`**, resolves template slugs to repo URLs via the same naming convention

When a new template is added to the examples repo, all three layers pick it up automatically.

## License

MIT
