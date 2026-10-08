# extension.dev, Claude Code Instructions

You are working on a browser extension project built with the [extension.dev](https://extension.dev) platform, a zero-config cross-browser extension framework.

## Core concepts

- **Only `manifest.json` is required.** The framework auto-detects your project structure from it.
- **Cross-browser via prefixes.** Use `chromium:` and `firefox:` prefixes in manifest.json for browser-specific fields. The build system strips these at build time.
- **Framework agnostic.** Vanilla JS/TS, React, Vue, Svelte, and Preact are auto-detected and configured.
- **Rspack-powered.** Fast Rust-based bundler. You can customize via `extension.config.js`.

## Template catalog

The extension.dev platform ships 50+ templates in the [examples](https://github.com/extension-js/examples) repo. The canonical registry is `templates-meta.json` published as a GitHub release asset and committed to the repo.

**How templates work:**

- `npx extension@latest create my-ext --template=<slug>` fetches from `https://github.com/extension-js/examples/tree/main/examples/<slug>`
- Template names are directory names under `examples/` in the repo
- Each template has auto-detected metadata (framework, surfaces, permissions) + optional curated metadata in `template.meta.json`

**Key templates by surface:**

| Surface        | Vanilla      | React            | Vue           | Svelte           | AI               |
| -------------- | ------------ | ---------------- | ------------- | ---------------- | ---------------- |
| Content script | `content`    | `content-react`  | `content-vue` | `content-svelte` | n/a              |
| Sidebar        | `sidebar`    | `sidebar-shadcn` | n/a           | n/a              | `ai-claude`      |
| Action popup   | `action`     | n/a              | n/a           | n/a              | `ai-chatgpt`     |
| New tab        | `newtab`     | `newtab-react`   | `newtab-vue`  | `newtab-svelte`  | n/a              |
| DevTools       | `devtools`   | `devtools-react` | `devtools-vue`| `devtools-svelte`| n/a              |
| Full framework | `javascript` | `react`          | `vue`         | `svelte`         | n/a              |

**When recommending a template:**

1. Match the user's desired surface (sidebar, content script, popup, etc.)
2. Match their framework preference
3. Prefer `featured: true` templates for common use cases
4. For AI-powered extensions, start from `ai-claude` or `ai-chatgpt`

**To browse all available templates:**

```bash
# The full catalog with metadata (framework, surfaces, permissions, etc.)
curl -sL https://media.extension.land/templates/latest.json | jq '.templates[] | {slug, description, uiFramework, surfaces}'
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
    manifest.json          # Required: the source of truth
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

# Build for production (no --browser means chromium: the build lands in dist/chromium/)
npm run build
# or: npx extension build

# Preview production build
npm run preview
# or: npx extension preview

# Target a specific browser (each build writes dist/<browser>/, so --browser=chrome writes dist/chrome/)
npm run dev -- --browser=firefox
npm run build -- --browser=chrome
npm run build -- --browser=firefox

# Zip for distribution
npm run build -- --zip
```

With the MCP server, `extension_dev` is the whole run recipe: it starts the
dev server and the browser, waits for the session and answers with `ready`
and `firstLogs`. `ready.status: "ready"` means the session is up and nothing
else needs calling; `extension_wait` is only for a session started with
`wait: false`, an answer whose `ready.status` was not ready, or a build-only
(`noBrowser`) session. After `extension_build`, read what was built with
`extension_analyze` (sizes, entry points, store checks) instead of listing
the output folder by hand.

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

1. **world: "MAIN" needs Firefox 128+.** Chromium and current Firefox both support it; only when targeting Firefox older than 128 prefix it with `chromium:` and provide a fallback.
2. **Side panels vs sidebar actions.** Chromium uses `side_panel` + `sidePanel` permission. Firefox uses `sidebar_action` (no permission needed).
3. **Service workers vs background scripts.** Chromium uses `service_worker` (single file). Firefox uses `scripts` (array).
4. **Environment variables.** Use `EXTENSION_PUBLIC_*` prefix for variables accessible in extension code. `import.meta.env.EXTENSION_PUBLIC_BROWSER` gives the current browser.
5. **Asset imports.** Import images/fonts directly in your code. The build system handles bundling.
6. **CSS Modules.** Use `*.module.css` / `*.module.scss`. Never use the `?url` suffix for CSS module imports, it breaks class name hashing.

## Answering questions about extension APIs

A question about a WebExtension API, a manifest key or a browser difference
("does Firefox support the side panel API?", "why is my service worker
losing state?") is answered from the docs, not from memory: call
`extension_docs_search` first, cite the page it returned, and only when it
returns nothing answer from what you know and say so. The search covers the
Extension.js docs and the extension.dev docs, which carry the per-browser
facts and the engine's own conventions.

## When creating new extensions

1. Check if an existing template matches the use case (see template catalog above)
2. If yes: `npx extension@latest create my-ext --template=<slug>`
3. If no: start from `manifest.json`, define what the extension needs
4. Add entry points referenced by the manifest (background, content scripts, UI pages)
5. Install framework deps if needed (React, Vue, etc.), the framework auto-detects them
6. Run it: `extension_dev` with the MCP server (one call, it answers when the session is ready; a scaffold needs no build to verify), or `npm run dev` without it

**Learning from examples:** When building a feature you haven't done before, read the source of a relevant template from the examples repo. The source for any template is at:

```
https://github.com/extension-js/examples/tree/main/examples/<slug>/src
```

## When debugging

### Live DOM inspection (`extension inspect` / MCP inspect tools)

Two ways to see inside a running extension. Both need an active dev session.

**Agent bridge (CDP-free, localhost): `extension inspect`.** Requires the session to be started with `--allow-control` (or `allowControl: true` on the `extension_dev` MCP tool). Sees open shadow roots but not closed ones.

```bash
# Structured summary of the content-script DOM in a tab
extension inspect --tab 1

# Inspect an open extension surface instead of a tab
extension inspect --context popup

# Include byte-capped HTML plus the last 20 console lines
extension inspect --tab 1 --include summary,html --with-console 20
```

| Flag                 | Default | Purpose                                                                                        |
| -------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `--context <name>`   | content | `content`/`page` (needs `--tab`) or an open surface: `popup`, `options`, `sidebar`, `devtools` |
| `--tab <id>`         | -       | Tab id to inspect (required for content/page)                                                  |
| `--include <list>`   | summary | Comma-separated: `summary`, `html` (html is byte-capped)                                       |
| `--max-bytes <n>`    | 262144  | Cap on returned HTML bytes                                                                     |
| `--with-console [n]` | 20      | Also include the last n console lines for the target                                           |

The `extension_dom_snapshot` MCP tool wraps this verb one-to-one.

**Debugging protocol (Chromium CDP): `extension_inspect` MCP tool.** Connects directly to the running session's debug port. Use it when the bridge is not enough: closed shadow roots (`deepDom`), selector probes, DOM snapshots, console summaries, or navigating the tab to a URL before inspecting. Returns structured events:

- `html` - full injected HTML (after content scripts run), with `htmlTruncated` when cut
- `summary` - root/script/style/link counts
- `meta` - readyState, viewport, frame count
- `domSnapshot` - structured tree (tag, id, classes, role; `domSnapshotTruncated` names the cap)
- `console` - error/warn counts + top unique messages
- `probes` - per-selector element counts and samples
- `extensionRoots` - extension root elements with reinject generations

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
- **Safari (macOS).** On Extension.js 4.1.21 or newer, `--browser=safari` builds the app, opens it, and after you enable the extension in Safari > Settings > Extensions it reloads on every save through the extension's bridge and streams background and content lines into the session log. Start it with `allowEval: true` and the bridge tools work: `extension_storage`, `extension_reload`, `extension_open` for surfaces, `extension_dom_snapshot` by tab id, `extension_logs`, and the assertions (`surface-rendered` reads the surface through the relay there). `extension_eval` in `content` or `page` needs a tab already open at the url, which you open in Safari by hand: `extension_open` with `url` and `extension_eval` in `background` are blocked by Safari's MV3 background CSP, and the engine says so. Safari has no CDP or RDP, so `extension_inspect` has no Safari path. Apple's Safari MCP server (`claude mcp add safari-mcp -- "/usr/bin/safaridriver" --mcp`, Safari 27+, after enabling Safari > Settings > Developer > "Allow remote automation and external agents") reads a page in its own isolated window with no extension-aware tool, and runs beside a dev session, since this server opens no automation session of its own.
- Read the build output from the path the build answered with (`extension_build` returns it as `outputPath`, `extension build` prints it) instead of assuming a folder name: a plain `npm run build` passes no `--browser`, so the engine targets chromium and writes `dist/chromium/`, while `--browser=chrome` and `extension_build` (chrome by default) write `dist/chrome/`
- `extension dev --wait` on the CLI blocks until the ready.json contract is stamped; the `extension_dev` tool already does this, so an answer whose `ready.status` is `ready` needs no `extension_wait` after it
- Use `npm run start` to test production builds (builds first, then launches)

### Triggering events without clicking (requires `--allow-control`)

- `extension open action`, fire the toolbar action (opens its popup, or replays `chrome.action.onClicked`).
- `extension open command --name <cmd>`, replay a `chrome.commands.onCommand` keyboard shortcut.
- `extension_list_extensions` (MCP tool; no CLI verb), list extensions with a live context in the browser (Chromium, read-only).

These replay your captured listeners, so they work on Chrome and Firefox, but carry **no user gesture**, so `activeTab` is not granted (the result reports `gesture: false`, plus a `warning` when the manifest declares `activeTab`). If you need a genuine-gesture click (activeTab granted), use [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)'s `trigger_extension_action` (Chromium only) alongside this server.

Two surfaces the engine's `open` verb cannot serve are handled by the MCP tool itself. `extension_open` with `surface: "newtab"`, `"history"` or `"bookmarks"` resolves the `chrome_url_overrides` page and opens it in a tab, which is the only place the browser renders it. `extension_open` with `surface: "sidebar"` on Chromium, when Chrome refuses `sidePanel.open()` for lack of a user gesture, opens the extension's own sidebar page in a tab, dispatches a synthetic click on it over CDP, calls `chrome.sidePanel.open` from inside that click and closes the tab: the real panel opens, the result says `gesture: "synthetic-click"`, and a warning notes that the toolbar wiring was not exercised. If that fails too, the sidebar document is rendered as a tab and the warning names the reason.

On a Chromium MV3 session, `extension_eval` reaches extension pages over CDP rather than the in-bundle relay: contexts `popup`, `options`, `sidebar`, `newtab`, `history`, `bookmarks`, and `context: "page"` with a `chrome-extension://` url. The MV3 extension CSP blocks the relay's string eval and script injection cannot reach an extension page at all, while the inspector path is governed by neither. The page must already be open (`extension_open` first); a closed one answers `E_NO_TARGET` with the call that opens it.

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
