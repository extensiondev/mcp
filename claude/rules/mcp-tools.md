# extension.dev MCP Tool Specification

Design document for `@extension.dev/mcp` — an MCP server that exposes extension.dev capabilities as tools for Claude Code, Claude Desktop, and any MCP-compatible client.

## Why this matters

Anthropic has no native browser extension tooling. The extension.dev platform already has clean programmatic APIs (`extensionCreate`, `extensionDev`, `extensionBuild`, `extensionPreview`). Wrapping these as MCP tools makes Claude the first AI that can natively scaffold, develop, build, and test browser extensions.

For Claude-heavy extension developers, this means: "Build me a Chrome extension that..." just works.

## The examples repo as the backbone

The [examples repo](https://github.com/extension-js/examples) is the template catalog, reference implementation library, and distribution channel for extension.dev. Every MCP tool that creates, recommends, or explains extension patterns should source its knowledge from this repo.

**Key resource:** `templates-meta.json` (published as a [nightly release asset](https://github.com/extension-js/examples/releases/tag/nightly))

This file contains structured metadata for every template: surfaces, framework, permissions, entry points, files, download URLs, and SHA256 integrity hashes. It is the single source of truth for what templates exist and what they contain.

**How `extension create` resolves templates today:**

```
User: npx extension create my-ext --template=sidebar-claude
                                           │
                                           ▼
programs/create/steps/import-external-template.ts
                                           │
          ┌────────────────────────────────┤
          │ Built-in name?                 │ Full GitHub URL? │ HTTP zip?
          ▼                                ▼                  ▼
https://github.com/extension-js/     Direct clone        axios + adm-zip
examples/tree/main/examples/<slug>   via go-git-it
          │
          ▼
go-git-it clones subtree → copies to project path → cleanup temp
```

No caching — every create call re-fetches from GitHub. The MCP server can improve this.

---

## Tool inventory

### Tier 1 — Core tools (ship first)

These map directly to existing programmatic APIs and provide immediate value.

#### `extension_create`

**Source:** `programs/create/module.ts` → `extensionCreate()`

**Purpose:** Scaffold a new browser extension project from a template.

```json
{
  "name": "extension_create",
  "description": "Create a new browser extension project from a template in the extension.dev template catalog. Use extension_list_templates to see available options.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectName": {
        "type": "string",
        "description": "Name of the extension project (used as directory name)"
      },
      "template": {
        "type": "string",
        "default": "typescript",
        "description": "Template slug from the extension.dev template catalog (e.g. 'react', 'sidebar-claude', 'content-vue'). Use extension_list_templates to discover options."
      },
      "install": {
        "type": "boolean",
        "default": true,
        "description": "Install dependencies after creation"
      }
    },
    "required": ["projectName"]
  }
}
```

**Returns:** `{ projectPath, projectName, template, depsInstalled }`

**Integration with examples repo:** The template slug maps directly to a directory under `examples/` in the repo. The tool resolves `https://github.com/extension-js/examples/tree/main/examples/<template>` via `go-git-it`.

---

#### `extension_list_templates`

**Source:** New — fetches and queries `templates-meta.json`

**Purpose:** Search and filter the template catalog. This is how Claude discovers what starting points exist before calling `extension_create`.

```json
{
  "name": "extension_list_templates",
  "description": "List available extension templates from the extension.dev template catalog. Filter by surface, framework, or tags. Returns structured metadata from templates-meta.json.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "surface": {
        "type": "string",
        "enum": [
          "content",
          "sidebar",
          "action",
          "newtab",
          "devtools",
          "options",
          "background"
        ],
        "description": "Filter by extension surface type"
      },
      "framework": {
        "type": "string",
        "enum": ["react", "vue", "svelte", "preact", ""],
        "description": "Filter by UI framework (empty string = vanilla JS)"
      },
      "tags": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Filter by tags (e.g. ['ai', 'chat'])"
      },
      "featured": {
        "type": "boolean",
        "description": "Only show featured templates"
      },
      "query": {
        "type": "string",
        "description": "Free-text search across slug, description, tags, and useCases"
      }
    }
  }
}
```

**Returns:** Array of `{ slug, description, uiFramework, surfaces, tags, difficulty, useCases, repositoryUrl, downloads }` — a filtered view of `templates-meta.json`.

**Implementation:**

1. Fetch `templates-meta.json` from `https://github.com/extension-js/examples/releases/download/nightly/templates-meta.json`
2. Cache locally (TTL: 1 hour) at `~/.cache/extension-js/templates-meta.json`
3. Apply filters against the `templates` array
4. Return matching entries with only the fields Claude needs

**Why this is Tier 1:** Without this tool, Claude would hard-code template names (which go stale). With it, Claude always knows the current catalog.

---

#### `extension_build`

**Source:** `programs/develop/module.ts` → `extensionBuild()`

**Purpose:** Build extension for production/distribution.

```json
{
  "name": "extension_build",
  "description": "Build a browser extension for production. Outputs to dist/<browser>/. Optionally creates .zip for store submission.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectPath": {
        "type": "string",
        "description": "Path to the extension project root"
      },
      "browser": {
        "type": "string",
        "enum": ["chrome", "chromium", "edge", "brave", "opera", "vivaldi", "yandex", "firefox", "waterfox", "librewolf", "safari", "chromium-based", "gecko-based", "firefox-based", "webkit-based"],
        "default": "chrome",
        "description": "Target browser"
      },
      "zip": {
        "type": "boolean",
        "default": false,
        "description": "Create a .zip file for store distribution"
      },
      "zipSource": {
        "type": "boolean",
        "default": false,
        "description": "Include source code zip (required by some stores)"
      }
    },
    "required": ["projectPath"]
  }
}
```

**Returns:** `{ outputPath, duration, zipPath?, warnings[] }`

`extension_build` also accepts `zipFilename` (string), `polyfill` (boolean, default false), `silent` (boolean), and `mode` (`development` | `production` | `none`, default `production`).

---

#### `extension_dev`

**Source:** `programs/develop/module.ts` → `extensionDev()`

**Purpose:** Start development server with HMR and browser launch.

```json
{
  "name": "extension_dev",
  "description": "Start the extension development server with hot module replacement. Launches a browser with the extension loaded.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectPath": {
        "type": "string",
        "description": "Path to the extension project root"
      },
      "browser": {
        "type": "string",
        "enum": ["chrome", "chromium", "edge", "brave", "opera", "vivaldi", "yandex", "firefox", "waterfox", "librewolf", "safari", "chromium-based", "gecko-based", "firefox-based", "webkit-based"],
        "default": "chrome"
      },
      "port": {
        "type": "number",
        "description": "Dev server port (0 for auto-assign)"
      },
      "noBrowser": {
        "type": "boolean",
        "default": false,
        "description": "Start dev server without launching browser"
      },
      "polyfill": {
        "type": "boolean",
        "default": true,
        "description": "Apply cross-browser polyfill"
      },
      "profile": { "type": "string", "description": "Browser profile path, or \"false\" for the default user profile" },
      "startingUrl": { "type": "string", "description": "URL the browser opens on launch" },
      "chromiumBinary": { "type": "string", "description": "Custom Chromium-based binary path" },
      "geckoBinary": { "type": "string", "description": "Custom Gecko/Firefox binary path" },
      "host": { "type": "string", "description": "Bind host (0.0.0.0 for Docker); default 127.0.0.1" },
      "publicHost": { "type": "string", "description": "Connectable host for HMR/reload when it differs from the bind host" },
      "extensions": { "type": "array", "items": { "type": "string" }, "description": "Companion extension paths or store URLs" },
      "allowControl": { "type": "boolean", "default": false, "description": "Enable the agent-bridge control channel" },
      "allowEval": { "type": "boolean", "default": false, "description": "Additionally enable extension_eval" }
    },
    "required": ["projectPath"]
  }
}
```

**Returns:** `{ port, browser, pid }` — long-running process, returns control info.

---

#### `extension_start`

**Source:** `programs/extension/commands/start.ts` → `extensionBuild()` + `extensionPreview()`

**Purpose:** Build and launch in production mode (no HMR). The "production test" workflow — builds first, then opens the browser with the built output.

```json
{
  "name": "extension_start",
  "description": "Build the extension for production and immediately preview it in a browser. Combines build + preview in one step. No hot reload.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectPath": {
        "type": "string",
        "description": "Path to the extension project root"
      },
      "browser": {
        "type": "string",
        "enum": ["chrome", "chromium", "edge", "brave", "opera", "vivaldi", "yandex", "firefox", "waterfox", "librewolf", "safari", "chromium-based", "gecko-based", "firefox-based", "webkit-based"],
        "default": "chrome"
      },
      "polyfill": {
        "type": "boolean",
        "default": true,
        "description": "Apply cross-browser polyfill (default true, unlike dev)"
      },
      "wait": {
        "type": "boolean",
        "default": false,
        "description": "Wait for ready.json contract and return structured status"
      },
      "waitTimeout": {
        "type": "number",
        "default": 60000,
        "description": "Timeout in ms when using wait mode"
      }
    },
    "required": ["projectPath"]
  }
}
```

**Returns:** When `wait: true`, returns the `ready.json` contract: `{ status, browser, port, pid, distPath, manifestPath, compiledAt }`. Otherwise returns `{ pid, browser }`.

Both `extension_start` and `extension_preview` also accept `port`, `noBrowser`, and the shared launch flags: `profile`, `startingUrl`, `chromiumBinary`, `geckoBinary`, `host`, `publicHost`, `extensions` (same shapes as on `extension_dev`).

**Why this is distinct from dev:** `dev` uses HMR and watches files. `start` builds once in production mode and launches — what you'd use to verify a production build works before publishing.

---

#### `extension_preview`

**Source:** `programs/develop/module.ts` → `extensionPreview()`

**Purpose:** Preview a built extension without dev server.

```json
{
  "name": "extension_preview",
  "description": "Preview a production-built extension in a browser. Uses dist/ output directly.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectPath": {
        "type": "string",
        "description": "Path to the extension project root"
      },
      "browser": {
        "type": "string",
        "enum": ["chrome", "chromium", "edge", "brave", "opera", "vivaldi", "yandex", "firefox", "waterfox", "librewolf", "safari", "chromium-based", "gecko-based", "firefox-based", "webkit-based"],
        "default": "chrome"
      }
    },
    "required": ["projectPath"]
  }
}
```

---

### Tier 2 — Intelligence tools (high DX value)

These combine extension.dev knowledge with the examples repo to make Claude _smart_ about extensions, not just a CLI wrapper.

#### `extension_get_template_source`

**Source:** New — reads files from the examples repo

**Purpose:** Read the source code of a template to learn its patterns before building something similar. This is how Claude learns extension patterns by example rather than from documentation.

```json
{
  "name": "extension_get_template_source",
  "description": "Read source files from a template in the extension.dev template catalog. Use this to learn implementation patterns before building something similar.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "slug": {
        "type": "string",
        "description": "Template slug (e.g. 'sidebar-claude', 'content-react')"
      },
      "files": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Specific files to read (e.g. ['src/manifest.json', 'src/background.ts']). If omitted, returns the file listing from templates-meta.json."
      }
    },
    "required": ["slug"]
  }
}
```

**Implementation:**

1. Look up the template in `templates-meta.json` to get its `files` array and `repositoryUrl`
2. If `files` param is omitted: return the file listing + metadata (surfaces, framework, permissions)
3. If `files` param is provided: fetch each file from `https://raw.githubusercontent.com/extension-js/examples/main/examples/<slug>/<file>`
4. Return file contents alongside the template metadata for context

**Why this matters:** When a user says "add a sidebar like the shadcn example," Claude can read the actual `sidebar-shadcn` source — its manifest structure, background script pattern, component layout — and replicate it accurately. The examples repo becomes a living pattern library for Claude.

**Advanced pattern learning:** Complex content script patterns (multi-level imports, MAIN world) can be learned from `content-multi-one-entry`, `content-multi-three-entries`, and `content-main-world` example sources.

---

#### `extension_manifest_validate`

**Source:** New tool — wraps manifest parsing logic from `plugin-web-extension`

**Purpose:** Validate and explain issues in a manifest.json.

```json
{
  "name": "extension_manifest_validate",
  "description": "Validate a manifest.json file for correctness across browsers. Reports missing fields, invalid permissions, and cross-browser compatibility issues. Cross-references against known-good manifests in the template catalog.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "manifestPath": {
        "type": "string",
        "description": "Path to manifest.json"
      },
      "browsers": {
        "type": "array",
        "items": { "type": "string" },
        "default": ["chrome", "firefox"],
        "description": "Browsers to validate against"
      }
    },
    "required": ["manifestPath"]
  }
}
```

**Returns:** `{ valid, errors[], warnings[], browserSupport: { chrome: {}, firefox: {} }, similarTemplates[] }`

The `similarTemplates` field lists templates from the catalog with similar surfaces/permissions — useful for cross-referencing a known-good example.

---

#### `extension_inspect`

**Source:** New tool; static analysis of the built `dist/` output

**Purpose:** Analyze a built extension's structure, size, and entry points.

```json
{
  "name": "extension_inspect",
  "description": "Inspect a built extension: file sizes, entry points, permissions used, and dependency analysis.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectPath": {
        "type": "string",
        "description": "Path to the extension project root"
      },
      "browser": {
        "type": "string",
        "default": "chrome"
      },
      "format": {
        "type": "string",
        "enum": ["summary", "tree", "json"],
        "default": "summary"
      }
    },
    "required": ["projectPath"]
  }
}
```

**Returns:** File tree with sizes, entry point map, permissions analysis, estimated store review flags.

---

#### `extension_add_feature`

**Source:** New tool — codegen based on examples repo patterns

**Purpose:** Add a feature surface to an existing extension (sidebar, content script, popup, options page, etc.)

```json
{
  "name": "extension_add_feature",
  "description": "Add a new feature surface to an existing extension. Generates the required files and updates manifest.json. Uses patterns from the extension.dev template catalog.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectPath": {
        "type": "string"
      },
      "feature": {
        "type": "string",
        "enum": [
          "sidebar",
          "popup",
          "options",
          "content-script",
          "background",
          "newtab",
          "devtools",
          "history",
          "bookmarks"
        ],
        "description": "Feature surface to add"
      },
      "framework": {
        "type": "string",
        "enum": ["react", "vue", "svelte", "preact", "vanilla"],
        "default": "react"
      }
    },
    "required": ["projectPath", "feature"]
  }
}
```

**Implementation:** Internally calls `extension_get_template_source` to fetch the canonical pattern for the requested surface+framework combination, then generates the files and updates manifest.json. The examples repo is the codegen source — not hard-coded templates.

---

#### `extension_source_inspect`

**Source:** `programs/extension/browsers/` → CDP/RDP source inspection system

**Purpose:** Live-inspect a running extension's DOM, console, and content script injection state over the debugging protocol. It gives Claude _eyes_ into the running extension. (This grew out of the engine's old `dev --source` CLI flags, which are no longer registered; the MCP connects to the CDP port directly.)

```json
{
  "name": "extension_source_inspect",
  "description": "Inspect a running extension's live state: DOM structure, content script injection, console messages, and selector queries. Requires an active dev or start session.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectPath": {
        "type": "string",
        "description": "Path to the extension project root (must have an active dev session)"
      },
      "url": {
        "type": "string",
        "description": "URL to inspect (navigates the browser tab). Defaults to the current tab."
      },
      "probe": {
        "type": "array",
        "items": { "type": "string" },
        "description": "CSS selectors to query — returns element counts and samples for each"
      },
      "include": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": ["html", "summary", "meta", "dom_snapshot", "console", "tree"]
        },
        "default": ["summary", "meta", "console"],
        "description": "What data to return"
      },
      "context": {
        "type": "string",
        "enum": [
          "page",
          "options",
          "sidepanel",
          "devtools",
          "newtab",
          "popup",
          "background"
        ],
        "default": "page",
        "description": "Extension context to inspect (page = content script on web page)"
      },
      "shadowDom": {
        "type": "string",
        "enum": ["off", "open-only", "all"],
        "default": "open-only",
        "description": "Shadow DOM traversal strategy"
      },
      "redact": {
        "type": "string",
        "enum": ["off", "safe", "strict"],
        "default": "safe",
        "description": "Redact sensitive content from HTML output"
      }
    },
    "required": ["projectPath"]
  }
}
```

**Returns:** Structured NDJSON events based on `include` selection:

| Event type            | What it contains                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `page_html`           | Full injected HTML (after content scripts run)                                             |
| `page_html_summary`   | Compact stats: root/script/style/link counts                                               |
| `page_meta`           | readyState, viewport dimensions, frame count                                               |
| `dom_snapshot`        | Structured tree: tag, id, classes, role, text length, child count (max 500 nodes, depth 6) |
| `console_summary`     | error/warn/info/log/debug counts + top 5 unique messages                                   |
| `extension_root_tree` | Extension root elements with reinject generations                                          |
| `selector_probe`      | Per-selector: count + element samples                                                      |

**Implementation:**

- Chromium: Uses the existing CDP client (`CDPClient.evaluate()`, `CDPClient.getPageHTML()`) via the already-running dev session's remote debugging port
- Firefox: Uses the existing RDP transport via the already-running dev session
- The `context` parameter maps to the Phase A expansion in `SESSION-SOURCE-EXTENSION-CONTEXTS.md` — currently only `page` works; extension UI contexts (`options`, `sidepanel`, `popup`, etc.) are planned

**Why this is the highest-value Tier 2 tool:** Claude can't fix what it can't see. When a content script doesn't inject, when a selector doesn't match, when the console is full of errors — this tool tells Claude exactly what's happening in the live browser. For complex multi-level content script chains, `probe: ["[data-extension-root]"]` instantly shows whether injection succeeded.

---

#### `extension_wait`

**Source:** `programs/extension/commands/dev-wait.ts`

**Purpose:** Poll for extension readiness after `dev` or `start`. Returns structured status from the `ready.json` contract.

```json
{
  "name": "extension_wait",
  "description": "Wait for a running dev or start session to be ready. Polls the ready.json contract file and returns structured status.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectPath": {
        "type": "string",
        "description": "Path to the extension project root"
      },
      "browser": {
        "type": "string",
        "default": "chrome",
        "description": "Browser to check readiness for"
      },
      "timeout": {
        "type": "number",
        "default": 60000,
        "description": "Timeout in milliseconds"
      }
    },
    "required": ["projectPath"]
  }
}
```

**Returns:** The `ready.json` contract:

```json
{
  "status": "ready",
  "command": "dev",
  "browser": "chrome",
  "port": 8080,
  "pid": 12345,
  "distPath": "/path/to/dist/chrome",
  "manifestPath": "/path/to/dist/chrome/manifest.json",
  "compiledAt": "2026-04-14T10:30:00.000Z",
  "startedAt": "2026-04-14T10:29:55.000Z"
}
```

**Why this matters for MCP:** When Claude starts a dev session via `extension_dev`, it needs to know when the extension is actually loaded and ready before calling `extension_source_inspect`. This tool provides that gate.

---

#### `extension_stop`

**Source:** MCP `lib/process-manager` + the `ready.json` contract (no CLI verb)

**Purpose:** Terminate a running dev/start/preview session — the dev server AND the browser it launched. The lifecycle counterpart to `extension_dev`/`extension_start`.

```json
{
  "name": "extension_stop",
  "description": "Stop a running dev, start, or preview session: terminates the dev server and the browser it launched.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectPath": {
        "type": "string",
        "description": "Path to the extension project root"
      },
      "browser": {
        "type": "string",
        "default": "chrome",
        "description": "Browser of the session to stop"
      },
      "all": {
        "type": "boolean",
        "default": false,
        "description": "Stop every session this server started"
      }
    },
    "required": []
  }
}
```

**Returns:** `{ projectPath, browser, pid, stopped, detail }` (or `{ stopped: [...] }` with `all: true`).

**How it finds the process:** the in-memory session registry first; if the MCP server restarted since the session began, it falls back to the `pid` recorded in the `ready.json` contract. It signals the whole process group (sessions are spawned detached), escalates SIGTERM → SIGKILL, and removes the stale `ready.json` so a later `extension_wait` cannot report a dead session as ready.

**Why this matters for MCP:** without a stop tool, every `extension_dev` call leaks a dev server and a browser window that outlive the agent's task. Agents should stop sessions when verification is done.

---

### Tier 3 — Browser management tools

#### `extension_install_browser`

**Source:** `programs/install/module.ts` → `extensionInstall()`

**Purpose:** Install managed browser binaries for testing.

```json
{
  "name": "extension_install_browser",
  "description": "Install a managed browser binary for extension testing. Useful in CI or fresh environments.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "browser": {
        "type": "string",
        "enum": ["chrome", "chromium", "edge", "firefox"]
      }
    },
    "required": ["browser"]
  }
}
```

#### `extension_list_browsers`

**Source:** `programs/install/module.ts` → `getManagedBrowsersCacheRoot()`

**Purpose:** List installed managed browsers and their paths.

---

#### `extension_detect_browsers`

**Source:** `programs/extension/browsers/` → binary resolution chain

**Purpose:** Detect which browsers are available on the system and their binary paths. Uses the same resolution chain as the CLI: managed cache → WSL → custom binary → npm location packages (`chrome-location2`, `firefox-location2`, `edge-location`).

```json
{
  "name": "extension_detect_browsers",
  "description": "Detect which browsers are available for extension development. Returns paths and capabilities for each detected browser.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "browsers": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": ["chrome", "chromium", "edge", "firefox"]
        },
        "description": "Browsers to check. If omitted, checks all."
      }
    }
  }
}
```

**Returns:**

```json
{
  "detected": [
    {
      "browser": "chrome",
      "binaryPath": "/usr/bin/google-chrome",
      "source": "system",
      "engine": "chromium",
      "cdpSupport": true
    },
    {
      "browser": "firefox",
      "binaryPath": "/usr/bin/firefox",
      "source": "system",
      "engine": "gecko",
      "cdpSupport": false,
      "rdpSupport": true
    }
  ],
  "managed": {
    "cacheRoot": "/home/user/.cache/extension.js/browsers",
    "installed": ["chromium"]
  }
}
```

**Why this matters:** Before Claude runs `extension_dev --browser=firefox`, it should know if Firefox is actually installed. This prevents "browser not found" errors and lets Claude suggest `extension_install_browser` when needed. Especially important for Docker/devcontainer environments.

---

#### `extension_uninstall_browser`

**Source:** `extension-install` → `extensionUninstall()`

**Purpose:** Remove a managed browser binary from the Extension.js cache (never system-installed browsers).

```json
{
  "name": "extension_uninstall_browser",
  "inputSchema": {
    "type": "object",
    "properties": {
      "browser": {
        "type": "string",
        "enum": ["chrome", "chromium", "edge", "firefox"],
        "description": "Managed browser to remove"
      },
      "all": {
        "type": "boolean",
        "default": false,
        "description": "Remove every managed browser binary"
      }
    },
    "required": []
  }
}
```

**Returns:** `{ status, target, duration }`

---

## Where each tool lives in the codebase

| MCP Tool                        | Program              | Source API                                | Data source                                 | Needs new code?                            |
| ------------------------------- | -------------------- | ----------------------------------------- | ------------------------------------------- | ------------------------------------------ |
| **Tier 1 — Core**               |                      |                                           |                                             |                                            |
| `extension_create`              | `programs/create`    | `extensionCreate()`                       | examples repo via go-git-it                 | Thin wrapper only                          |
| `extension_list_templates`      | New                  | —                                         | `templates-meta.json` release asset         | Fetch + filter + cache                     |
| `extension_build`               | `programs/develop`   | `extensionBuild()`                        | —                                           | Thin wrapper only                          |
| `extension_dev`                 | `programs/develop`   | `extensionDev()`                          | —                                           | Thin wrapper + process management          |
| `extension_start`               | `programs/extension` | `extensionBuild()` + `extensionPreview()` | —                                           | Thin wrapper (already orchestrated in CLI) |
| `extension_preview`             | `programs/develop`   | `extensionPreview()`                      | —                                           | Thin wrapper only                          |
| **Tier 2 — Intelligence**       |                      |                                           |                                             |                                            |
| `extension_get_template_source` | New                  | —                                         | `templates-meta.json` + raw GitHub          | Fetch + read files                         |
| `extension_manifest_validate`   | `programs/develop`   | `plugin-web-extension`                    | `templates-meta.json` for similar templates | Extract validation logic                   |
| `extension_inspect`             | `programs/develop`   | `--source` flag logic                     | —                                           | Extract into callable API                  |
| `extension_source_inspect`      | `programs/extension` | CDP client / RDP transport                | Live browser via debugging protocol         | Wire to running session                    |
| `extension_list_extensions`     | MCP `lib/cdp`        | `Extensions.getExtensionInfo` (read-only) | Live browser via CDP (Chromium)             | MCP tool (no CLI verb)                      |
| `extension_wait`                | `programs/extension` | `dev-wait.ts`                             | `ready.json` contract file                  | Thin wrapper (exists in CLI)               |
| `extension_stop`                | MCP `lib/process-manager` | session registry + group signal      | Session registry + `ready.json` pid         | MCP tool (no CLI verb)                      |
| `extension_add_feature`         | New                  | `extension_get_template_source`           | examples repo patterns                      | Codegen from examples                      |
| **Agent bridge — act / triggers** |                    |                                           |                                             |                                            |
| `extension_eval`                | `programs/extension` | bridge control channel                    | Live extension context                      | Wraps `extension eval` (`--allow-eval`)     |
| `extension_storage`             | `programs/extension` | bridge control channel                    | `chrome.storage`                            | Wraps `extension storage`                   |
| `extension_reload`              | `programs/extension` | bridge control channel                    | Live extension                              | Wraps `extension reload`                    |
| `extension_open`                | `programs/extension` | bridge control channel                    | Surfaces + `action`/`command` replay        | Wraps `extension open`                      |
| `extension_logs`                | `programs/extension` | bridge log/control channel                | `logs.ndjson` + live channel                | Wraps `extension logs`                      |
| **Tier 3 — Browser management** |                      |                                           |                                             |                                            |
| `extension_install_browser`     | `programs/install`   | `extensionInstall()`                      | —                                           | Thin wrapper only                          |
| `extension_list_browsers`       | `programs/install`   | `getManagedBrowsersCacheRoot()`           | —                                           | Thin wrapper only                          |
| `extension_detect_browsers`     | `programs/extension` | Binary resolution chain                   | System PATH + managed cache                 | Extract from launch logic                  |

## Changes needed in existing programs

### `programs/develop/`

- **Extract manifest validation** from `plugin-web-extension` into a standalone callable function. Currently validation is embedded in the Rspack plugin lifecycle.
- **Extract source inspection** from `--source` flag handling into `extensionInspect(projectPath, options)` API.
- **Add `--json` output mode** to `extensionBuild()` return value. Currently returns `BuildSummary` but it could be richer with file-level details.
- **Structured error types.** Current errors are human-readable strings. MCP tools need error codes + structured details for Claude to act on.

### `programs/create/`

- **Template listing API.** Add `extensionListTemplates(filters?)` that fetches+caches `templates-meta.json` and returns filtered results. This serves both the MCP `extension_list_templates` tool and any future CLI `extension list` command.
- **Dry-run mode.** Add `dryRun` option to `extensionCreate()` that returns the file list without writing. Useful for Claude to explain what will be created before doing it.
- **Template caching.** The current no-cache approach (re-download from GitHub every time) works but is slow. An MCP server that handles many create calls should cache the examples repo or individual template tarballs with a TTL.

### `programs/install/`

- **Already clean.** `extensionInstall()` and `extensionUninstall()` are ready for wrapping.

### `programs/extension/` (CLI + browsers)

- **`--json` flag for all commands.** Machine-readable output for every command. This benefits not just MCP but any programmatic consumer. The `--ai-help` / `--format json` flags already exist — extend this pattern to command output.
- **Exit codes.** Ensure distinct exit codes for different failure modes (missing manifest, build error, browser not found, etc.)
- **`extension list` command.** Expose `extensionListTemplates()` as a CLI command. Shows the catalog in terminal or JSON.
- **Extract binary detection into callable API.** The browser resolution chain (managed cache → WSL → custom binary → npm location packages) is embedded in `chromium-launch/index.ts` and `firefox-launch/index.ts`. Extract into `extensionDetectBrowsers()` for the `extension_detect_browsers` MCP tool.
- **Extract source inspection into MCP-callable API.** The `--source` system is deeply integrated into the browser launch lifecycle. For MCP, we need a way to call it against an _already-running_ dev session. The ready.json contract already gives us port/pid — the MCP server can connect to the CDP/RDP port directly.
- **Extract wait mode into callable API.** The `dev-wait.ts` logic is CLI-only. Expose `extensionWait(projectPath, browser, timeout)` as a programmatic function.
- **Expose the `start` command programmatically.** Currently `start` is CLI-only orchestration (build then preview). Add `extensionStart()` that chains `extensionBuild()` + `extensionPreview()` with the ready.json contract.

### Examples repo

- **AI metadata in `template.meta.json`.** See "AI-relevant metadata fields" section below.
- **Ensure `templates-meta.json` is always published** as a release asset and committed to the repo, so both the MCP server and Claude Code rules can consume it.

---

## AI-relevant metadata fields

Proposed additions to the `template.meta.json` curated schema (via `CURATED_ALLOWED_KEYS` in `generate-templates-meta.mjs`):

```javascript
const CURATED_ALLOWED_KEYS = [
  // Existing
  "title",
  "featured",
  "tags",
  "difficulty",
  "timeToFirstSuccessMinutes",
  "firstSteps",
  "useCases",
  "docsUrl",
  // Proposed additions
  "aiPromptExamples", // Example user prompts this template is good for
  "aiRecommendFor", // Keywords/intents that should recommend this template
  "patternExplanation", // Brief explanation of the architectural pattern
  "keyFiles", // Most important files to read to understand the pattern
];
```

**Example for `sidebar-claude/template.meta.json`:**

```json
{
  "title": "Claude AI Sidebar",
  "featured": true,
  "tags": ["ai", "claude", "anthropic", "chat", "sidebar", "react", "shadcn"],
  "difficulty": "beginner",
  "timeToFirstSuccessMinutes": 3,
  "useCases": [
    "AI assistant sidebar for any webpage",
    "Claude-powered research companion"
  ],
  "aiPromptExamples": [
    "Build a Chrome extension with a Claude chatbot sidebar",
    "Create a browser extension that lets me talk to AI on any page",
    "Make an extension with an Anthropic-powered assistant panel"
  ],
  "aiRecommendFor": [
    "claude",
    "anthropic",
    "ai chat",
    "llm sidebar",
    "ai assistant"
  ],
  "patternExplanation": "Sidebar panel with React chat UI calling Anthropic SDK. API key stored in chrome.storage.local. Cross-browser via chromium:side_panel + firefox:sidebar_action.",
  "keyFiles": [
    "src/manifest.json",
    "src/lib/claude.ts",
    "src/sidebar/SidebarApp.tsx",
    "src/background.ts"
  ]
}
```

These fields enable `extension_list_templates` to match user intent ("I want to build an AI sidebar") to the right template, and `extension_get_template_source` to read only the key files rather than everything.

---

## Implementation plan

### Phase 1: Foundation (changes to existing programs)

1. Add `--json` output flag to build/dev/start/preview/create commands in `programs/extension`
2. Extract manifest validation into `extensionValidateManifest()` in `programs/develop`
3. Add `extensionListTemplates(filters?)` to `programs/create` — fetches and caches `templates-meta.json`
4. Add `extension list` CLI command wrapping the above
5. Extract browser detection into `extensionDetectBrowsers()` in `programs/extension`
6. Extract wait mode into `extensionWait()` in `programs/extension`
7. Add AI metadata fields to `CURATED_ALLOWED_KEYS` in `generate-templates-meta.mjs`
8. Populate `template.meta.json` with AI fields for key templates (sidebar-claude, action-chatgpt, sidebar-transformers-js)

### Phase 2: MCP Server package

1. New package: `programs/mcp` or standalone `@extension.dev/mcp`
2. Implement Tier 1 tools: `extension_create`, `extension_list_templates`, `extension_build`, `extension_dev`, `extension_start`, `extension_preview`
3. `extension_list_templates` caches `templates-meta.json` with 1-hour TTL
4. Register on MCP directory (npmjs.com + modelcontextprotocol.io)

### Phase 3: Live inspection tools

1. `extension_wait` — poll ready.json contract (gate for inspection tools)
2. `extension_source_inspect` — connect to running session's CDP/RDP port for live DOM inspection
3. `extension_detect_browsers` — system browser detection
4. `extension_get_template_source` — reads from examples repo via raw.githubusercontent.com
5. `extension_manifest_validate` — cross-browser validation + similar template suggestions

### Phase 4: Codegen + advanced tools

1. `extension_inspect` — static build analysis from `--source` extraction
2. `extension_add_feature` — codegen sourced from examples repo patterns

### Phase 5: Feedback loop

1. MCP server reports which templates Claude recommends most → feed into `featured` rankings
2. Track which `aiPromptExamples` lead to successful creates → improve matching
3. New templates added to examples repo are immediately available via `extension_list_templates` (no MCP server update needed — it reads `templates-meta.json` at runtime)

---

## DX priorities for power users

Typical power-user workflows that drive tool prioritization:

- Multi-browser extensions (Chrome + Firefox)
- Complex content script import trees (multi-level chains across manifest entries)
- Docker/devcontainer development
- Heavy Claude Code usage for rapid iteration

**Highest-value tools by workflow:**

| Workflow                     | Tool                                                         | Why                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Debugging injection failures | `extension_source_inspect`                                   | `probe: ["[data-extension-root]"]` shows injection state, reinject generation, console errors — no manual DevTools needed |
| Docker/devcontainer          | `extension_detect_browsers` + `extension_wait`               | Check browser availability, gate on dev server readiness                                                                  |
| Multi-browser                | `extension_manifest_validate` + `extension_build`            | Catch manifest divergence early, build for `chrome,firefox`                                                               |
| Learning patterns            | `extension_list_templates` + `extension_get_template_source` | Read `content-multi-one-entry`, `content-multi-three-entries` for multi-level import patterns                             |
| Rapid prototyping            | `extension_add_feature`                                      | "Add a sidebar" generates correct manifest + files + background handler                                                   |

**Why the examples repo is central:** Complex patterns (multi-level content script imports, MAIN world isolation, cross-browser sidebars) are documented as working examples. `extension_get_template_source` gives Claude the canonical implementation to reference when building or debugging these patterns.

**Why source inspection is the highest-value tool:** The most time-consuming extension debugging failure is "it didn't load." `extension_source_inspect` with `probe` and `console_summary` turns manual Chrome DevTools investigation into a one-call Claude diagnosis.
