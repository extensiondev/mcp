# extension.dev — Claude Code Instructions

You are working on a browser extension project built with the [extension.dev](https://extension.dev) platform, a zero-config cross-browser extension framework.

## Core concepts

- **Only `manifest.json` is required.** The framework auto-detects your project structure from it.
- **Cross-browser via prefixes.** Use `chromium:` and `firefox:` prefixes in manifest.json for browser-specific fields. The build system strips these at build time.
- **Framework agnostic.** Vanilla JS/TS, React, Vue, Svelte, and Preact are auto-detected and configured.
- **Rspack-powered.** Fast Rust-based bundler. You can customize via `extension.config.js`.

## Template catalog

The extension.dev platform ships 60+ templates in the [examples](https://github.com/extension-js/examples) repo. The canonical registry is `templates-meta.json` published as a GitHub release asset and committed to the repo.

**How templates work:**

- `npx extension@latest create my-ext --template=<slug>` fetches from `https://github.com/extension-js/examples/tree/main/examples/<slug>`
- Template names are directory names under `examples/` in the repo
- Each template has auto-detected metadata (framework, surfaces, permissions) + optional curated metadata in `template.meta.json`

**Key templates by surface:**

| Surface        | Vanilla      | React            | Vue           | Svelte           | AI               |
| -------------- | ------------ | ---------------- | ------------- | ---------------- | ---------------- |
| Content script | `content`    | `content-react`  | `content-vue` | `content-svelte` | —                |
| Sidebar        | `sidebar`    | `sidebar-shadcn` | —             | —                | `sidebar-claude` |
| Action popup   | `action`     | —                | —             | —                | `action-chatgpt` |
| New tab        | `new`        | `new-react`      | `new-vue`     | `new-svelte`     | —                |
| Full framework | `javascript` | `react`          | `vue`         | `svelte`         | —                |

**When recommending a template:**

1. Match the user's desired surface (sidebar, content script, popup, etc.)
2. Match their framework preference
3. Prefer `featured: true` templates for common use cases
4. For AI-powered extensions, start from `sidebar-claude` or `action-chatgpt`

**To browse all available templates:**

```bash
# The full catalog with metadata (framework, surfaces, permissions, etc.)
curl -sL https://github.com/extension-js/examples/releases/download/nightly/templates-meta.json | jq '.templates[] | {slug, description, uiFramework, surfaces}'
```

**Pre-built distributions** are available for every template:

```
https://github.com/extension-js/examples/releases/download/nightly/<slug>.<browser>.zip
```

## Project structure

A typical extension.dev project:

```
my-extension/
  src/
    manifest.json          # Required — the source of truth
    background.ts          # Service worker (Chromium) / background script (Firefox)
    content/               # Content scripts
      scripts.tsx
      styles.css
    sidebar/               # Sidebar panel UI
      index.html
      scripts.tsx
      styles.css
    images/
      icon.png
  extension.config.js      # Optional build config
  extension-env.d.ts       # Auto-generated types
  package.json
  tsconfig.json
```

## manifest.json cross-browser format

The framework extends the standard manifest with browser prefixes:

```json
{
  "chromium:manifest_version": 3,
  "firefox:manifest_version": 2,
  "name": "My Extension",
  "chromium:action": { "default_title": "Click me" },
  "firefox:browser_action": { "default_title": "Click me" },
  "chromium:side_panel": { "default_path": "sidebar/index.html" },
  "firefox:sidebar_action": { "default_panel": "sidebar/index.html" },
  "background": {
    "chromium:service_worker": "background.ts",
    "firefox:scripts": ["background.ts"]
  }
}
```

**Rules:**

- Fields without a prefix apply to all browsers
- `chromium:` fields apply to Chrome, Edge, and Chromium-based browsers
- `firefox:` fields apply to Firefox and Gecko-based browsers
- `chromium:permissions` and `firefox:permissions` can differ

## Commands

```bash
# Scaffold a new extension
npx extension@latest create my-extension --template=react

# Development with HMR
npm run dev
# or: npx extension dev

# Build for production
npm run build
# or: npx extension build

# Preview production build
npm run preview
# or: npx extension preview

# Target a specific browser
npm run dev -- --browser=firefox
npm run build -- --browser=chrome,firefox

# Zip for distribution
npm run build -- --zip
```

## extension.config.js

```javascript
/** @type {import('extension').FileConfig} */
export default {
  browser: {
    chrome: {
      profile: "./dist/profile-chrome", // Persist browser profile
      startingUrl: "https://example.com",
    },
  },
  config: (rspackConfig) => {
    // Mutate Rspack config here
    return rspackConfig;
  },
};
```

## Important gotchas

1. **world: "MAIN" is Chromium-only.** If your content script uses `"world": "MAIN"`, prefix it with `chromium:` and provide a Firefox fallback or skip.
2. **Side panels vs sidebar actions.** Chromium uses `side_panel` + `sidePanel` permission. Firefox uses `sidebar_action` (no permission needed).
3. **Service workers vs background scripts.** Chromium uses `service_worker` (single file). Firefox uses `scripts` (array).
4. **Environment variables.** Use `EXTENSION_PUBLIC_*` prefix for variables accessible in extension code. `import.meta.env.EXTENSION_PUBLIC_BROWSER` gives the current browser.
5. **Asset imports.** Import images/fonts directly in your code. The build system handles bundling.
6. **CSS Modules.** Use `*.module.css` / `*.module.scss`. Never use the `?url` suffix for CSS module imports — it breaks class name hashing.

## When creating new extensions

1. Check if an existing template matches the use case (see template catalog above)
2. If yes: `npx extension@latest create my-ext --template=<slug>`
3. If no: start from `manifest.json` — define what the extension needs
4. Add entry points referenced by the manifest (background, content scripts, UI pages)
5. Install framework deps if needed (React, Vue, etc.) — the framework auto-detects them
6. Run `npm run dev` — the dev server handles the rest

**Learning from examples:** When building a feature you haven't done before, read the source of a relevant template from the examples repo. The source for any template is at:

```
https://github.com/extension-js/examples/tree/main/examples/<slug>/src
```

## When debugging

### Source inspection (`--source`)

The `--source` flag on `dev` gives live DOM inspection of a running extension:

```bash
# Basic: see injected HTML after content scripts run
npm run dev -- --source https://example.com

# Structured JSON output (best for programmatic use)
npm run dev -- --source https://example.com --source-format json

# Probe specific selectors
npm run dev -- --source https://example.com --source-probe "#my-root,.sidebar"

# Full inspection: DOM snapshots, console summary, diffs on rebuild
npm run dev -- --source https://example.com --source-dom --source-console --source-diff
```

**Available --source sub-flags:**

| Flag                         | Default   | Purpose                                           |
| ---------------------------- | --------- | ------------------------------------------------- |
| `--source [url]`             | —         | Open URL and print live HTML after injection      |
| `--watch-source`             | true      | Re-print on rebuilds                              |
| `--source-format`            | json      | Output format: `pretty`, `json`, `ndjson`         |
| `--source-summary`           | auto      | Compact stats instead of full HTML                |
| `--source-meta`              | auto      | Page metadata: readyState, viewport, frames       |
| `--source-probe <selectors>` | —         | CSS selectors to query (comma-separated)          |
| `--source-tree`              | off       | Extension root DOM tree: `off`, `root-only`       |
| `--source-console`           | auto      | Console counts: error/warn/info/log/debug         |
| `--source-dom`               | auto      | DOM snapshots and structural diffs                |
| `--source-max-bytes`         | 256KB     | Truncate HTML output (0 = unlimited)              |
| `--source-redact`            | safe      | Redact sensitive content: `off`, `safe`, `strict` |
| `--source-include-shadow`    | open-only | Shadow DOM: `off`, `open-only`, `all`             |
| `--source-diff`              | auto      | Include diff metadata on watch updates            |

**Output event types** (in JSON/NDJSON format):

- `page_html` — full injected HTML
- `page_html_summary` — root/script/style/link counts
- `page_meta` — readyState, viewport, frame count
- `dom_snapshot` — structured tree (tag, id, classes, role, max 500 nodes)
- `dom_diff` — added/removed/changed between rebuilds
- `console_summary` — error/warn counts + top 5 unique messages
- `selector_probe` — per-selector element counts and samples
- `extension_root_tree` — extension root elements with reinject generations

### Unified logging (`--logs`)

Stream extension logs from all contexts to the terminal:

```bash
# All contexts at info level
npm run dev -- --logs info

# Only content scripts and background
npm run dev -- --logs debug --log-context content,background

# JSON format for programmatic consumption
npm run dev -- --logs info --log-format json

# Filter by URL pattern
npm run dev -- --logs info --log-url "example.com"
```

### Other debugging tools

- Use `--browser=firefox` to test cross-browser compatibility
- Check `dist/<browser>/` for build output
- Use `--wait` flag to check if dev session is ready (outputs ready.json contract)
- Use `npm run start` to test production builds (builds first, then launches)

### Triggering events without clicking (requires `--allow-control`)

- `extension open action` — fire the toolbar action (opens its popup, or replays `chrome.action.onClicked`).
- `extension open command --name <cmd>` — replay a `chrome.commands.onCommand` keyboard shortcut.
- `extension_list_extensions` (MCP tool; no CLI verb) — list extensions with a live context in the browser (Chromium, read-only).

These replay your captured listeners, so they work on Chrome and Firefox — but carry **no user gesture**, so `activeTab` is not granted (the result reports `gesture: false`, plus a `warning` when the manifest declares `activeTab`). If you need a genuine-gesture click (activeTab granted), use [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)'s `trigger_extension_action` (Chromium only) alongside this server.

## Contributing templates to the examples repo

If you create a new extension pattern worth sharing:

1. Place the example in `examples/<slug>/` following the standard layout
2. Add `template.meta.json` with curated metadata:
   ```json
   {
     "title": "Human-readable title",
     "featured": false,
     "tags": ["relevant", "tags"],
     "difficulty": "beginner",
     "timeToFirstSuccessMinutes": 3,
     "useCases": ["What users would build with this"],
     "firstSteps": ["Step 1", "Step 2"]
   }
   ```
3. The `generate-templates-meta.mjs` script auto-detects: framework, surfaces, permissions, entry points, CSS tech, config files
4. Run `pnpm run generate` to regenerate `templates-meta.json`
5. The CI pipeline handles: build, test (Playwright), package, and nightly release
