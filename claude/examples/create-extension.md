# Example: Create a new extension from scratch

## Prompt

> Create a Chrome extension that adds a floating button to every page. When clicked, it summarizes the page content and shows the summary in a popup overlay.

## How Claude should approach this

1. **Scaffold with extension.js:**

   ```bash
   npx extension@latest create page-summarizer --template=react
   cd page-summarizer
   ```

2. **Define the manifest**, content script for the floating button, background script for orchestration:

   ```json
   {
     "chromium:manifest_version": 3,
     "firefox:manifest_version": 2,
     "name": "Page Summarizer",
     "content_scripts": [
       {
         "matches": ["<all_urls>"],
         "js": ["content/scripts.tsx"],
         "css": ["content/styles.css"]
       }
     ],
     "background": {
       "chromium:service_worker": "background.ts",
       "firefox:scripts": ["background.ts"]
     },
     "permissions": ["activeTab"]
   }
   ```

3. **Build the content script**, inject a floating button, handle click to extract `document.body.innerText`, send to background for processing.

4. **Test it:**
   ```bash
   npm run dev
   ```

## Key decisions Claude should make

- Content script for page injection (not popup, since it needs page context)
- Background script for any API calls (content scripts have CORS restrictions)
- Use `chrome.runtime.sendMessage` for content <-> background communication
