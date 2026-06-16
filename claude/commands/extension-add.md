---
description: Add a feature surface (sidebar, popup, content script, etc.) to an existing extension
argument-hint: "<feature> [framework]"
---

Add a new feature surface to the current extension project. The user said: $ARGUMENTS

## Parse arguments

- First argument: feature type — one of: `sidebar`, `popup`, `content-script`, `background`, `newtab`, `options`, `devtools`
- Second argument (optional): framework — one of: `react`, `vue`, `svelte`, `preact`, `vanilla`. Default: detect from existing project, fall back to `react`

## Steps

1. **Validate the project**
   - Check that `src/manifest.json` exists
   - Read it to understand what's already configured
   - Detect the framework from existing dependencies in `package.json`

2. **Get the reference pattern**
   If MCP tool `extension_add_feature` is available, use it — it returns the exact manifest additions, files to create, and reference template.

   If MCP tool `extension_get_template_source` is available, read the reference template source to get real implementation patterns.

3. **Update manifest.json**
   Add the required fields to `src/manifest.json`. Use the extension.dev cross-browser format:

   | Feature        | Chromium                                                                                                  | Firefox                                                             |
   | -------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
   | Sidebar        | `"chromium:side_panel": {"default_path": "sidebar/index.html"}` + `"chromium:permissions": ["sidePanel"]` | `"firefox:sidebar_action": {"default_panel": "sidebar/index.html"}` |
   | Popup          | `"chromium:action": {"default_popup": "action/index.html"}`                                               | `"firefox:browser_action": {"default_popup": "action/index.html"}`  |
   | Content script | `"content_scripts": [{"matches": ["<all_urls>"], "js": ["content/scripts.ts"]}]`                          | Same                                                                |
   | Background     | `"background": {"chromium:service_worker": "background.ts", "firefox:scripts": ["background.ts"]}`        | Same (prefixed)                                                     |
   | New tab        | `"chrome_url_overrides": {"newtab": "newtab/index.html"}`                                                 | Same                                                                |
   | Options        | `"options_ui": {"page": "options/index.html", "open_in_tab": true}`                                       | Same                                                                |
   | DevTools       | `"devtools_page": "devtools/index.html"`                                                                  | Same                                                                |

4. **Create the files**
   For HTML-based features (sidebar, popup, newtab, options, devtools):
   - `src/<feature>/index.html` — HTML entry with script tag
   - `src/<feature>/scripts.tsx` — Framework mount point (or `.ts` for vanilla)
   - `src/<feature>/styles.css` — Stylesheet
   - `src/<feature>/<Feature>App.tsx` — Main component (non-vanilla only)

   For content scripts:
   - `src/content/scripts.ts` — Entry point
   - `src/content/styles.css` — Injected styles

   For background:
   - `src/background.ts` — Service worker / background script

5. **Handle sidebar specifically**
   If adding a sidebar, also create/update `src/background.ts`:

   ```typescript
   // Chromium: open sidebar on action click
   chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });

   // Firefox: sidebar_action handles this automatically
   ```

6. **Report what was done**
   List all files created and manifest changes made. Suggest `npm run dev` to test.
