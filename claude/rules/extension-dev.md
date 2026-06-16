# extension.dev Development Rules for Claude

## File creation order

When Claude creates a new extension, follow this order:

1. `manifest.json` — always first, defines the extension surface
2. Background script (if needed) — handles browser events
3. UI entry points — HTML files referenced by manifest
4. UI scripts — React/Vue/Svelte components mounted into HTML
5. Styles — CSS/Tailwind files imported by scripts
6. `package.json` — dependencies based on what was used above
7. Config files — tsconfig.json, postcss.config.js, extension.config.js only if needed

## manifest.json rules

- Always use the `$schema` field for validation: `"$schema": "https://json.schemastore.org/chrome-manifest.json"`
- Use `chromium:manifest_version: 3` and `firefox:manifest_version: 2` for cross-browser
- Icon paths are relative to `src/` (where manifest.json lives)
- Entry point paths (HTML, scripts) are relative to `src/`
- Always include icons at sizes: 16, 32, 48, 64, 128

## Script entry points

- Background: referenced in `manifest.json` under `background`
- Content scripts: referenced in `manifest.json` under `content_scripts`
- UI pages (popup, sidebar, options, newtab): referenced as HTML files in manifest, include a `<script src="./scripts.tsx">` tag

## HTML page pattern

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Page Title</title>
  </head>
  <body>
    <noscript>You need to enable JavaScript to run this extension.</noscript>
    <div id="root"></div>
  </body>
  <script src="./scripts.tsx"></script>
</html>
```

## React mounting pattern

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

## Browser detection

```typescript
const isFirefoxLike =
  import.meta.env.EXTENSION_PUBLIC_BROWSER === "firefox" ||
  import.meta.env.EXTENSION_PUBLIC_BROWSER === "gecko-based";
```

## Storage API

Use `chrome.storage.local` for persistent data. It works cross-browser when the polyfill is active (default).

## Permissions

Only request permissions the extension actually needs. Common ones:

- `sidePanel` — Chromium only, for side panel UI
- `storage` — for chrome.storage API
- `activeTab` — for accessing the current tab
- `tabs` — for tab management
- `scripting` — for programmatic script injection
