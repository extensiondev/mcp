---
description: Create, develop, or build a browser extension with extension.dev
argument-hint: "<action> [options]"
---

You are helping build a browser extension with the extension.dev platform. The user said: $ARGUMENTS

## Actions

Parse the user's intent from `$ARGUMENTS` and execute the matching action:

### "create <name>" or "new <name>", Scaffold a new extension

1. If MCP tool `extension_templates` is available, use it to find the best template matching the user's description (check for surface type, framework, and keywords)
2. If not, check the template catalog: `curl -sL https://media.extension.land/templates/latest.json | jq '.templates[] | {slug, description, uiFramework, surfaces}'`
3. If MCP tool `extension_create` is available, use it (its answer's `nextSteps` is the next step); otherwise run `npx extension@latest create <name> --template=<best-match>`
4. Report what was created. A scaffold needs no build to verify it: do not run `npm run build` to check it; the next step is running it (below)

### "dev" or "run", Start development

1. If MCP tool `extension_dev` is available, call it with the project path: it starts the dev server and the browser, waits for the session and answers with `ready` and `firstLogs`. `ready.status: "ready"` means the session is up: do not call `extension_wait` after it (that tool is for sessions started with `wait: false`, an answer whose `ready.status` was not ready, and build-only sessions)
2. Otherwise run `npm run dev` (or `npx extension dev`) in the project root
3. Tell the user the browser opened with their extension loaded
4. Mention HMR is active, changes will hot-reload

### "build", Build for production

1. If MCP tool `extension_build` is available, use it (chrome by default; its answer carries `outputPath`). Otherwise run `npm run build` (or `npx extension build`)
2. After success, report the output folder the tool or the CLI answered with, never an assumed one: a plain `npm run build` passes no `--browser`, so the engine targets chromium and writes `dist/chromium/`; `--browser=chrome` and `extension_build` write `dist/chrome/`
3. If the user mentions "firefox" or "both", also build with `--browser=firefox`
4. If they mention "zip" or "store", add `--zip`
5. To say what is in the build (sizes, entry points, store checks), call `extension_analyze` with the same project path and browser; do not list or read the output folder with shell commands

### "add <feature>", Add a feature surface

1. If MCP tool `extension_add_feature` is available, use it to get the manifest additions and file list
2. Otherwise, determine what's needed from the feature type:
   - **sidebar**: `chromium:side_panel` + `firefox:sidebar_action` + `sidePanel` permission + background handler
   - **popup**: `chromium:action` + `firefox:browser_action`
   - **content-script**: `content_scripts` array in manifest
   - **newtab**: `chrome_url_overrides.newtab`
   - **background**: `background.service_worker` (Chromium) + `background.scripts` (Firefox)
3. Create the files and update `src/manifest.json`

### "debug" or "inspect", Debug a running extension

1. If MCP tool `extension_inspect` is available, use it with `include: ["html", "console", "extension_roots"]`
2. If there's a URL mentioned, pass it as the target
3. If there are CSS selectors mentioned, pass them as `probe`
4. Report: injected HTML, console errors, extension root state

### "validate", Check manifest for issues

1. If MCP tool `extension_manifest_validate` is available, use it
2. Otherwise, read `src/manifest.json` and check:
   - Required fields: `name`, `manifest_version`
   - Cross-browser: `chromium:` and `firefox:` prefixed fields match
   - Permissions: `sidePanel` present if `side_panel` is declared
   - Background: `service_worker` (Chromium) and `scripts` (Firefox) both present

### "template <query>", Search for a template

1. If MCP tool `extension_templates` is available, use it with the query
2. Otherwise, search the catalog JSON
3. Show matching templates with slug, description, framework, and surfaces

### No action / general question

If the user's input doesn't match an action, treat it as a description of what they want to build. Recommend the best template and offer to create it.

## Cross-browser rules

Always use the extension.dev cross-browser manifest format:

- `chromium:manifest_version: 3`, `firefox:manifest_version: 2`
- `chromium:action` vs `firefox:browser_action`
- `chromium:side_panel` vs `firefox:sidebar_action`
- `background.chromium:service_worker` vs `background.firefox:scripts`
