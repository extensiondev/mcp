---
description: Prepare an extension for store submission (Chrome Web Store, Firefox Add-ons)
argument-hint: "[chrome|firefox|both]"
---

Prepare the current extension for store submission. The user said: $ARGUMENTS

## Parse arguments

Default to `both` (Chrome + Firefox). If the user specifies `chrome` or `firefox`, target only that store.

## Steps

1. **Validate the manifest**
   If MCP tool `extension_manifest_validate` is available, use it with the target browsers.
   Otherwise, read `src/manifest.json` and check:
   - Has `name`, `version`, `description`
   - Has appropriate `manifest_version` for each target
   - Permissions are minimal (no unnecessary permissions)
   - Has icons (at least 16x16, 48x48, 128x128)

2. **Build for each target browser**

   ```bash
   npx extension build --browser=chrome --zip
   npx extension build --browser=firefox --zip
   ```

3. **Inspect the builds**
   If MCP tool `extension_inspect` is available, use it for each browser build.
   Check:
   - Total size under 10MB (store limit)
   - No source maps in production build
   - Has manifest.json in dist
   - Has icons

4. **Report store readiness**

   ### Chrome Web Store
   - Zip location: `dist/chrome/<name>.zip`
   - Submit at: https://chrome.google.com/webstore/devconsole
   - Checklist:
     - [ ] manifest_version: 3
     - [ ] Icons: 128x128 PNG
     - [ ] Description under 132 characters (for listing)
     - [ ] Screenshots: 1280x800 or 640x400
     - [ ] Privacy policy URL (if using sensitive permissions)

   ### Firefox Add-ons (AMO)
   - Zip location: `dist/firefox/<name>.zip`
   - Submit at: https://addons.mozilla.org/developers/
   - Checklist:
     - [ ] manifest_version: 2 (recommended for broadest compat) or 3
     - [ ] No Chrome-only APIs without polyfill
     - [ ] Source code zip if using a bundler: `npx extension build --browser=firefox --zip --zip-source`
     - [ ] AMO requires source code review for minified/bundled code

5. **Flag issues** that would cause store rejection:
   - `<all_urls>` host permission without justification
   - `activeTab` + `scripting` without clear use case
   - Remote code loading (eval, Function constructor, remote scripts)
   - Excessive permissions for the extension's functionality
