# Cross-Browser Rules for Claude

## Manifest field mapping

| Feature               | Chromium                              | Firefox                       |
| --------------------- | ------------------------------------- | ----------------------------- |
| Manifest version      | `chromium:manifest_version: 3`        | `firefox:manifest_version: 2` |
| Toolbar button        | `chromium:action`                     | `firefox:browser_action`      |
| Side panel            | `chromium:side_panel`                 | `firefox:sidebar_action`      |
| Background            | `chromium:service_worker` (string)    | `firefox:scripts` (array)     |
| Side panel permission | `chromium:permissions: ["sidePanel"]` | Not needed                    |

## Side panel / Sidebar

Chromium:

```json
{
  "chromium:side_panel": {
    "default_path": "sidebar/index.html"
  },
  "chromium:permissions": ["sidePanel"]
}
```

Firefox:

```json
{
  "firefox:sidebar_action": {
    "default_panel": "sidebar/index.html"
  }
}
```

Background script to open:

```typescript
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

## Content scripts with world: "MAIN"

`world: "MAIN"` only works on Chromium. Must be prefixed:

```json
{
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/scripts.ts"],
      "chromium:world": "MAIN"
    }
  ]
}
```

Firefox will ignore the `chromium:world` field and run in the default isolated world.

## API differences

- Chromium: use `chrome.*` namespace for Chrome-specific APIs (sidePanel, etc.)
- Firefox: use `browser.*` namespace (auto-polyfilled by the framework)
- For cross-browser code: use `browser.*` when possible — the polyfill maps it to `chrome.*` on Chromium

## Testing across browsers

```bash
# Dev mode
npm run dev -- --browser=chrome
npm run dev -- --browser=firefox
npm run dev -- --browser=edge

# Build for multiple browsers
npm run build -- --browser=chrome,firefox
```
