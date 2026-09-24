---
description: Debug a running extension, inspect DOM, console, content script injection
argument-hint: "[url] [selectors...]"
---

Debug the currently running extension dev session. The user said: $ARGUMENTS

## Steps

1. **Check for a running dev session**
   - Look for `dist/extension-js/chrome/ready.json` in the project root
   - If MCP tool `extension_wait` is available, use it with a short timeout (3s) to check
   - If no session: tell the user to start one with `/extension dev` or `npm run dev`

2. **Inspect the live state**
   If MCP tool `extension_inspect` is available:
   - Pass `include: ["html", "summary", "meta", "console", "extension_roots"]`
   - If the user provided a URL in `$ARGUMENTS`, pass it as `url`
   - If the user provided CSS selectors (strings starting with `#`, `.`, or `[`), pass them as `probe`
   - Report the results in a structured way

   If MCP is not available:
   - If the session was started with `--allow-control`, suggest the CLI equivalent: `npx extension inspect --tab <id> --include summary,html --with-console 20`
   - Otherwise read `dist/extension-js/chrome/ready.json` to get the CDP port and suggest Chrome DevTools inspection

3. **Exercise event handlers (when the bug is in an action / command / shortcut)**
   If the session was started with `--allow-control`, fire the events a user would, without clicking:
   - `extension_open` with `surface: "action"`, triggers the toolbar action (opens its popup, or replays `chrome.action.onClicked`).
   - `extension_open` with `surface: "command"` and `name: "<cmd>"`, replays a `chrome.commands.onCommand` keyboard shortcut.
   - Then re-inspect or read `extension_logs` to see what the handler did.

   **Caveat:** replay carries no user gesture, so `activeTab` is NOT granted. If the handler depends on `activeTab` (e.g. `chrome.scripting.executeScript` on the active tab, `captureVisibleTab`), the result includes `gesture: false` and a `warning`, and behavior differs from a real click. For a genuine-gesture click (activeTab granted), use chrome-devtools-mcp's `trigger_extension_action` (Chromium only) alongside this server.

   To see what else is loaded in the browser (Chromium): `extension_list_extensions`.

   **Safari sessions** have no CDP, but a dev session on Extension.js 4.1.28 or newer streams background and content lines over the extension's bridge, so `extension_logs` and the log-based assertions work. A dev session started with `extension_dev --browser=safari` may also hold a Safari automation window; read it with `extension_assert` `content-script-injected` (navigates the window to the URL and looks for a DOM root the script mounted), `extension_eval` with context `page`, and `extension_open` with `url`. `extension_doctor` shows a `safari-window` leg. Neither this server nor Apple's `safari-mcp` can open the popup or background page, and Safari grants one automation session at a time, so `safari-mcp` only works while no dev session holds the window. Everything else is Web Inspector, attended.

4. **Diagnose common issues**
   Based on what you find, check for:
   - **"It didn't load"**: Check extension root count. If 0, content scripts may not be injecting. Check manifest `content_scripts` matches patterns and the target URL.
   - **Console errors**: Report top errors. Common ones:
     - `Uncaught TypeError`, likely a missing import or wrong module format
     - `Content Security Policy`, extension CSP blocking inline scripts
     - `chrome.runtime.lastError`, API permission missing
   - **Wrong page**: Check if the content script `matches` pattern in manifest covers the target URL
   - **Shadow DOM empty**: Extension root exists but shadow content is empty, likely a CSS or framework mounting issue

5. **Suggest fixes** based on the diagnosis

## Examples

- `/extension-debug`, inspect the default page target
- `/extension-debug https://example.com`, inspect a specific URL
- `/extension-debug https://example.com #my-root .sidebar`, inspect URL and probe selectors
