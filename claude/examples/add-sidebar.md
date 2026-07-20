# Example: Add a sidebar panel to an existing extension

## Prompt

> Add a sidebar panel to my extension that shows a settings page.

## How Claude should approach this

1. **Update manifest.json**, add side panel config for both browsers:

   ```json
   {
     "chromium:side_panel": {
       "default_path": "sidebar/index.html"
     },
     "firefox:sidebar_action": {
       "default_panel": "sidebar/index.html"
     },
     "chromium:permissions": ["sidePanel"]
   }
   ```

2. **Add action button** to trigger the sidebar:

   ```json
   {
     "chromium:action": { "default_title": "Open Settings" },
     "firefox:browser_action": { "default_title": "Open Settings" }
   }
   ```

3. **Create background.ts** to handle the action click:

   ```typescript
   const isFirefoxLike =
     import.meta.env.EXTENSION_PUBLIC_BROWSER === "firefox" ||
     import.meta.env.EXTENSION_PUBLIC_BROWSER === "gecko-based";

   if (isFirefoxLike) {
     browser.browserAction.onClicked.addListener(() => {
       browser.sidebarAction.open();
     });
   } else {
     chrome.action.onClicked.addListener(() => {
       chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
     });
   }
   ```

4. **Create the sidebar UI**, `src/sidebar/index.html`, `src/sidebar/scripts.tsx`, `src/sidebar/styles.css`

5. **Test both browsers:**
   ```bash
   npm run dev -- --browser=chrome
   npm run dev -- --browser=firefox
   ```
