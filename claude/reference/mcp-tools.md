# MCP tools

Generated from the schemas the server registers (`src/index.ts`); do not edit by hand. Regenerate with `pnpm docs:tools`. A test fails when this file and the schemas disagree.

40 tools.

## extension_add_feature

Plan the surface before adding an options page, a popup, a side panel, a content script, a devtools panel, a new tab page or a background script. It answers manifest additions, files and template and changes nothing; then validate the manifest and run extension_dev.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root |
| `feature` | "sidebar" \| "popup" \| "options" \| "content-script" \| "background" \| "newtab" \| "devtools" | yes |  | Surface to add |
| `framework` | "react" \| "vue" \| "svelte" \| "preact" \| "vanilla" | no | `"react"` | UI framework. |

## extension_analyze

Analyze a BUILT extension in dist/<browser>: sizes, entries, permissions, store checks (not on a dev build).

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root |
| `browser` | string | no | `"chrome"` | Browser build to analyze. |
| `format` | "summary" \| "tree" \| "json" | no | `"summary"` | Answer shape. |

## extension_approvals

Read or revoke one approval on extension.dev; revoke a pending or unused one approved by mistake (owner token).

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "status" \| "revoke" | no | `"status"` | status (default) or revoke. |
| `approvalId` | string | yes |  | The apr_ id. |
| `project` | string | no |  | Stored login '<workspace>/<project>' when several exist. |
| `api` | string | no |  | Platform URL; default EXTENSION_DEV_API_URL. |

## extension_assert

Run a test stage on an extension_dev or extension_start session: pass, fail, not ready (a precondition) or inconclusive per expectation. Debug-port checks: extension_start allowControl:true; content-script-injected and console-errors-empty: extension_dev only.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `expect` | array of object | yes |  | Each { assert: <id>, ...args }: background-worker-booted; surface-rendered {surface, selector?, minNodes?}; content-script-injected {url}; storage-key-present {key, area?, equals?, context?}; console-errors-empty {context?, since?, ignore?}; page-world-clean {url, pageGlobals?}; no-outside-requests {allow?, durationMs?}. |
| `browser` | string | no |  | Session browser; required when several run. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |

## extension_auth

Sign in to an existing extension.dev project (a code for extension.dev/device, then deviceCode and waitSeconds), list stored logins, or clear them. Identity is the stored token, not the working directory; value.server.verdict is confirmed, refused or unavailable. Tokens live 7 days (CI: Access tokens).

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "status" \| "login" \| "logout" | no | `"status"` | status lists logins; login signs in; logout deletes the local login. |
| `project` | string | no |  | '<workspace>/<project>' from console.extension.dev (new: extension.dev/new). |
| `projectPath` | string | no |  | login: the directory whose GitHub origin names the project. |
| `projects` | array \| string | no |  | login: 1 to 20 existing projects of one workspace, at most 48 characters each, or "*" with workspace. |
| `workspace` | string | no |  | login with projects: "*": the workspace. |
| `deviceCode` | string | no |  | login: resume token. |
| `waitSeconds` | number | no |  | With deviceCode, seconds the call blocks for approval (0 to 900). |
| `api` | string | no |  | Platform URL; default EXTENSION_DEV_API_URL. |

## extension_browsers

Find, install and remove browsers Extension.js launches. detect (default) scans system and managed ones; install downloads hundreds of MB in one blocking call; uninstall never touches a system install.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "detect" \| "list" \| "install" \| "uninstall" | no | `"detect"` | list reads the managed cache. |
| `browsers` | array of "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" | no |  | detect: only these. |
| `browser` | "chrome" \| "chromium" \| "edge" \| "firefox" | no |  | install or uninstall: the managed binary. |
| `all` | boolean | no | `false` | uninstall: every managed binary. |

## extension_build

Build the extension on this machine into dist/<browser>/; never for sharing (extension_builds). Refuses a dist a dev session serves unless outDir.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root |
| `browser` | "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" \| "chromium-based" \| "gecko-based" \| "firefox-based" \| "webkit-based" | no | `"chrome"` | Target browser; *-based pairs with chromiumBinary or geckoBinary. |
| `zip` | boolean | no | `false` | Also write a .zip. |
| `zipSource` | boolean | no | `false` | Also zip the source. |
| `zipFilename` | string | no |  | Zip file name. |
| `polyfill` | boolean | no | `false` | Cross-browser polyfill. |
| `silent` | boolean | no | `false` | Suppress build output. |
| `mode` | "development" \| "production" \| "none" | no | `"production"` | development: readable, source maps (with outDir); none: unset. |
| `skipValidation` | boolean | no | `false` | Build despite manifest errors. |
| `outDir` | string | no |  | Build folder instead of dist (Extension.js 4.1.36+). |
| `appName` | string | no |  | Safari: app name. |
| `bundleId` | string | no |  | Safari: your reverse-DNS bundle id. |
| `developmentTeam` | string | no |  | Safari: Apple team id; "" for ad-hoc. |
| `macOsOnly` | boolean | no | `true` | Safari: false adds iOS and iPadOS. |
| `forceRegenerate` | boolean | no | `false` | Safari: regenerate the Xcode project. |

## extension_builds

Read, download, rebuild and configure platform builds. list/get rows: env is the build environment, channels the pins holding it now. A rebuild spends allowance; a push, only on the build branch when it changes the root directory ([skip build] pushes, docs-only, other branches spend nothing).

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "list" \| "get" \| "logs" \| "download" \| "rebuild" \| "recheck" \| "configure" \| "create-channel" \| "configure-channel" \| "delete-channel" | no | `"list"` | list: recent builds, lastPush; get: one build; logs; download: a verified package; recheck: rerun integrity; rebuild; configure: buildSettings; create-, configure-channel; delete-channel: console only. |
| `buildId` | string | no |  | Commit sha, never the build number; required for get, logs, download, recheck. |
| `buildEnv` | "staging" \| "production" | no |  | rebuild: staging (default, Preview) or production (Stable, stores). |
| `buildSettings` | object | no |  | configure: per-browser changes, e.g. { firefox: { buildCommand: 'pnpm build' } }. |
| `approvalId` | string | no |  | Approved approval id. |
| `channel` | string | no |  | Channel name, max 40 chars. |
| `description` | string | no |  | Channel description, max 200 chars. |
| `color` | string | no |  | Channel color, #rrggbb. |
| `audience` | "public" \| "private" | no |  | private, or public (owner approval); default the project's visibility. |
| `browser` | string | no |  | chrome, edge, firefox, safari; download requires it and takes source. |
| `projectPath` | string | no |  | Project directory; picks its login. |
| `to` | string | no |  | download: directory (default the cache). |
| `limit` | number | no |  | list: 1 to 50 (default 10). |
| `project` | string | no |  | Stored login '<workspace>/<project>' when several exist. |
| `waitSeconds` | number | no |  | Seconds to wait for the result, 0 to 600 (default 180), and with approvalId for the approval. get waits for a build's verdict (a rebuild or a push). |
| `api` | string | no |  | Platform URL; default EXTENSION_DEV_API_URL. |

## extension_create

Create an extension project from a template (extension_templates); it may init git. It is verified, so the next step is extension_dev, not a build; `scripts` name the outputs (`npm run build` writes dist/chromium). Sends one draft_seeded event; the readme's Telemetry section turns it off.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectName` | string | yes |  | Project directory name. Alias: name. |
| `parentDir` | string | no |  | Where to create it; default the MCP server process cwd. Aliases: parent, into. |
| `template` | string | no | `"typescript"` | Catalog slug, e.g. 'react'. |
| `install` | boolean | no | `true` | Install dependencies. |

## extension_dev

Run the extension while you edit it (dev build, hot reload, browser): the first call for "run my extension". ready.status "ready" means nothing else to call. extension_start runs the production build.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root |
| `browser` | "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" \| "chromium-based" \| "gecko-based" \| "firefox-based" \| "webkit-based" | no | `"chrome"` | Target browser; *-based pairs with chromiumBinary or geckoBinary. |
| `port` | number | no |  | Port (0 picks one). |
| `noBrowser` | boolean | no | `false` | No browser. |
| `polyfill` | boolean | no | `true` | Cross-browser polyfill. |
| `profile` | string | no |  | Profile path; "false" reuses the real one. |
| `startingUrl` | string | no |  | URL opened on launch. |
| `chromiumBinary` | string | no |  | Chromium binary; browser still names the target family. |
| `geckoBinary` | string | no |  | Gecko binary; browser still names the target family. |
| `host` | string | no |  | Bind host (default 127.0.0.1). |
| `publicHost` | string | no |  | Host the browser dials, if not host. |
| `extensions` | array of string | no |  | Extra extensions to load. |
| `headless` | boolean | no |  | true: headless; false: a visible window; omitted: env decides. |
| `appName` | string | no |  | Safari: app name. |
| `bundleId` | string | no |  | Safari: your reverse-DNS bundle id. |
| `developmentTeam` | string | no |  | Safari: Apple team id; omitted, ad-hoc. |
| `macOsOnly` | boolean | no | `true` | Safari: false adds iOS and iPadOS. |
| `forceRegenerate` | boolean | no | `false` | Safari: regenerate the Xcode project. |
| `enableExtension` | boolean | no | `false` | Safari: enable it in Settings (Accessibility grant). |
| `replace` | boolean | no | `false` | Replace this project's session; else refused. |
| `allowControl` | boolean | no | `true` | Control channel for the bridge verbs. |
| `wait` | boolean | no | `true` | Wait up to 45 s for ready. |
| `allowEval` | boolean | no | `false` | Enable extension_eval; implies allowControl. |
| `idleMinutes` | number | no |  | Idle minutes before it ends itself; 0 never; default 30 headless. |

## extension_docs_search

Find the docs page to cite before answering about a WebExtension API, a manifest key, a permission or a browser difference. It searches the Extension.js and extension.dev docs (free) and answers pages with URLs. Memory is the fallback only when it returns nothing.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `query` | string | yes |  | What to look up. |
| `limit` | number | no | `5` | Pages to return. |
| `api` | string | no |  | Platform URL; default EXTENSION_DEV_API_URL. |

## extension_doctor

Diagnose a dev session leg by leg, each with its remediation; run it first when an act tool errors unexpectedly. value.capabilities reads WebGPU and isolation; with no projectPath it checks node, the CLI and the template cache.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | no |  | Project root; omit for an environment check. |
| `browser` | string | no |  | Session browser; required when several run. |

## extension_dom_snapshot

Take a shallow DOM snapshot of one open surface or targetId, or list what is open (listTargets on the debug port, listTabs). Closed shadow roots and probes: extension_inspect.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `tab` | number | no |  | chrome.tabs id; else url, else the active tab. |
| `url` | string | no |  | content/page: the tab by url. |
| `tabUrl` | string | no |  | The tab by url from the target list. |
| `targetId` | string | no |  | A page's targetId (extension_open, or dom_snapshot listTargets); overrides url. |
| `listTargets` | boolean | no | `false` | List page targets and return. |
| `listTabs` | boolean | no | `false` | List tabs with ids and return. |
| `context` | "content" \| "page" \| "popup" \| "options" \| "sidebar" \| "devtools" \| "newtab" \| "history" \| "bookmarks" | no | `"content"` | A closed surface is opened first (as extension_open does); the answer then says opened: true. |
| `include` | array of "summary" \| "html" \| "elements" | no | `["summary"]` | summary: counts. html: markup to maxBytes. elements: visible interactive elements with role, name, unique selector and state. |
| `maxBytes` | number | no | `262144` | Byte cap on the html. |
| `withConsole` | number \| boolean | no |  | Console lines: a count, or true for 50. |
| `browser` | string | no |  | Session browser; required when several run. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |

## extension_element

Click, fill, read or wait for one element by CSS selector, or send trusted mouse and key input (move, press, release, type, key, scroll) in an open surface, a page by url or a targetId. Runs no caller code, so no allowEval; Chromium only.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `action` | "click" \| "fill" \| "text" \| "wait" \| "move" \| "press" \| "release" \| "type" \| "key" \| "scroll" | yes |  | click (a real mouse press), fill, text, wait (until visible); move, press, release, type, key, scroll send trusted input. |
| `selector` | string | no |  | CSS selector matching exactly one element (the point for input actions; focused before type and key). |
| `value` | string | no |  | fill: the value to set. |
| `x` | number | no |  | press, release, scroll: the point's x in CSS pixels of the viewport, when no selector. |
| `y` | number | no |  | The point's y, with x. |
| `points` | array of object | no |  | move: the path, one trusted mousemove per point; a selector's center goes first. |
| `button` | "left" \| "middle" \| "right" | no |  | press, release: the mouse button (default left). |
| `text` | string | no |  | type: the characters, one key down and up each; a newline is Enter. |
| `key` | string | no |  | key: a key name (Enter, Escape, Tab, ArrowDown, F5) or one character. |
| `modifiers` | array of "Alt" \| "Control" \| "Meta" \| "Shift" | no |  | Modifiers held during the input. |
| `deltaX` | number | no |  | scroll: wheel delta in CSS pixels (positive scrolls right). |
| `deltaY` | number | no |  | scroll: wheel delta in CSS pixels (positive scrolls down). |
| `context` | "popup" \| "options" \| "sidebar" \| "devtools" \| "newtab" \| "history" \| "bookmarks" | no |  | An open surface (extension_open first). |
| `url` | string | no |  | A web page's tab by url. |
| `targetId` | string | no |  | A page's targetId (extension_open, or dom_snapshot listTargets); overrides url. |
| `browser` | string | no |  | Session browser; required when several run. |
| `timeout` | number | no |  | Timeout ms; wait polls until it (default 10000, max 30000). |

## extension_eval

Evaluate JavaScript in a running extension's background, surface, content script, page or targetId. Needs allowEval:true at start (by hand: --allow-eval) on every route, the debug port included, whose runs carry a user gesture. Safari: pages only; extension_logs reads the background.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `expression` | string | yes |  | Expression to evaluate. |
| `context` | "background" \| "popup" \| "options" \| "sidebar" \| "devtools" \| "newtab" \| "history" \| "bookmarks" \| "content" \| "page" | no |  | Default background; a closed surface is opened first (as extension_open does). |
| `url` | string | no |  | content/page: the tab by url. |
| `tab` | number | no |  | chrome.tabs id to break a url tie. |
| `targetId` | string | no |  | A page's targetId (extension_open, or dom_snapshot listTargets); overrides url. |
| `observe` | boolean \| string | no | `false` | true also answers value.observation: the surface's elements once it loaded and settled; a surface name (popup, options, sidebar...) reads that one. |
| `browser` | string | no |  | Session browser; required when several run. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |
| `until` | object | no |  | Repeat until truthy ({} for defaults); never sleep in a shell. |

## extension_inspect

Inspect a web page (or targetId) over the debugger protocol: HTML, DOM, console, probes, closed shadow roots. Surfaces by name are extension_dom_snapshot. Firefox: agent bridge, needs allowEval:true.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `url` | string | no |  | Navigate here first, or the url substring to pick. |
| `targetId` | string | no |  | A page's targetId (extension_open, or dom_snapshot listTargets); overrides url. |
| `probe` | array of string | no |  | CSS selectors to count and sample. |
| `include` | array of "html" \| "summary" \| "meta" \| "dom_snapshot" \| "console" \| "extension_roots" | no | `["summary","meta","console"]` | What to include |
| `browser` | string | no |  | Session browser; required when several run. |
| `maxBytes` | number | no | `262144` | HTML byte cap (0 = none). |
| `deepDom` | boolean | no | `false` | Pierce closed shadow roots; other open roots are not crossed. |

## extension_list_extensions

List the extensions in a session's browser; its own carries ownExtension:true.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `browser` | string | no |  | Session browser; required when several run. |

## extension_logs

Read a dev session's logs from every context in one timeline, or follow:true for live frames after the replayed ring. Works on a `npx extension dev` run by hand (follow needs --allow-control there); not on extension_start.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `browser` | string | no |  | Session browser; default the live session, else chrome. |
| `level` | "off" \| "error" \| "warn" \| "info" \| "debug" \| "trace" \| "all" | no | `"all"` | Minimum severity. |
| `context` | array of "background" \| "content" \| "sidebar" \| "popup" \| "options" \| "devtools" \| "newtab" \| "history" \| "bookmarks" | no |  | Only these contexts. |
| `signalsOnly` | boolean | no | `false` | Only dx.signal diagnostics. |
| `since` | number | no |  | Only events after this seq (the polling cursor). |
| `url` | string | no |  | Only events whose url matches (glob or substring). |
| `tab` | number | no |  | Only this tab id. |
| `match` | string | no |  | Only lines matching this regex or substring. |
| `follow` | boolean | no | `false` | Collect live frames. |
| `followMs` | number | no | `4000` | ms to collect live frames (500 to 15000). |
| `limit` | number | no | `200` | How many recent events. |

## extension_manifest_validate

Validate a manifest.json across browsers; buildBlocking lists the errors that make extension_build refuse.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `manifestPath` | string | no |  | Path to manifest.json; or projectPath. |
| `projectPath` | string | no |  | Project root (manifest at root or src/). |
| `browsers` | array of string | no | `["chrome","firefox","edge"]` | Browsers to validate against. |
| `browser` | string | no |  | One browser; alias for browsers:[browser]. |
| `include` | array of "similarTemplates" | no |  | Optional sections; similarTemplates adds up to five catalog templates with the same surfaces. |

## extension_network

Stub a network response on a Chromium session: add a rule (method, URL or glob, status, body or json), list or clear the rules, or read which requests hit one or missed. Rules last until extension_stop. Firefox is refused.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `action` | "add" \| "list" \| "clear" \| "requests" | yes |  | add a rule, list or clear the rules, or read the requests seen. |
| `method` | string | no |  | add: HTTP method; default ANY. |
| `url` | string | no |  | add: exact URL, or a glob with * and ?. |
| `status` | number | no | `200` | add: HTTP status to answer. |
| `body` | string | no |  | add: response text. |
| `json` | any | no |  | add: response as a JSON value; not with body. |
| `contentType` | string | no |  | add: Content-Type; default by body or json. |
| `browser` | string | no |  | Session browser; required when several run. |

## extension_open

Open an extension surface or a url, or replay the toolbar action, a context menu item or a shortcut, over the control channel (by hand: --allow-control). A url opens in a background tab and answers target.targetId for extension_screenshot and the readers. A replay carries no user gesture.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `surface` | "popup" \| "options" \| "sidebar" \| "devtools" \| "newtab" \| "history" \| "bookmarks" \| "action" \| "command" | no |  | Surface to open; action and command replay; devtools is Chromium only. |
| `name` | string | no |  | command: the chrome.commands name. |
| `menuItemId` | string | no |  | action: replay contextMenus.onClicked for this menu item id instead of the toolbar click (Chromium, over the debug port; no gesture). |
| `panel` | string | no |  | devtools: panel title. |
| `waitMs` | number | no |  | devtools: ms to wait (default 15000). |
| `reload` | boolean | no | `false` | devtools: reload the inspected tab. |
| `url` | string | no |  | Url to open (a path resolves to the extension). |
| `foreground` | boolean | no | `false` | Raise the tab; only for a page the person must act on. |
| `newTab` | boolean | no | `false` | New tab even if one shows the url. |
| `tab` | number | no |  | With url: navigate this chrome.tabs id (not a tab position; from dom_snapshot listTabs: true); with menuItemId: the tab the click is for (default the active tab). |
| `asTab` | boolean | no | `false` | Render the surface in a tab. |
| `observe` | boolean \| string | no | `false` | true also answers value.observation: the surface's elements once it loaded and settled; a surface name (popup, options, sidebar...) reads that one. |
| `browser` | string | no |  | Session browser; required when several run. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |

## extension_preview_web

Preview a build in the web emulator; share:true returns a link anyone opens with no install (the preview://build default is for developing extension.dev itself). Tester links: extension_publish. Content scripts run only on sample pages, a limit of the preview only.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root |
| `project` | string | no |  | Stored login '<workspace>/<project>' when several exist. |
| `browser` | "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" | no | `"chrome"` | dist/<browser> to preview; Firefox view for Firefox. |
| `build` | boolean | no | `true` | Build first. |
| `distPath` | string | no |  | Preview this directory; implies build:false. |
| `hostUrl` | string | no |  | Local preview server origin. |
| `probe` | boolean | no | `true` | Check the artifact loads. |
| `open` | boolean | no | `false` | Also open it in a live session. |
| `openIn` | "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" | no |  | Session browser to open in. |
| `share` | boolean | no | `false` | Upload for share.previewUrl; metered against the workspace's allowance, and hands over the code. |

## extension_project_create

Create an extension.dev project from a folder (projectPath, uploaded, no push; again: re-seed and rebuild) or a GitHub repo, BEFORE extension_auth. First call: a URL a signed-in workspace member approves; resume with deviceCode and waitSeconds, the login is stored too. The first build spends one build of the workspace's monthly allowance, build command exactly as stored. projects: up to 10 per approval, at most 10 per hour, never split silently.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `project` | string | no |  | New '<workspace>/<project>'. |
| `projectPath` | string | no |  | Folder holding manifest.json, uploaded as it is (absolute or relative to the server cwd; default: the cwd when it holds manifest.json or extension.config.*). node_modules, dist, .git, .extension-dev, .zip, .crx, .xpi, .env*, *.pem and .gitignore entries stay out; 4 MB zipped at most. On a project whose source was uploaded, this re-seeds it from the new archive and rebuilds it (no token comes back); extension_builds rebuild rebuilds its stored tree without a new upload. |
| `repo` | string | no |  | GitHub '<owner>/<repo>' the source is pushed to; instead of projectPath. |
| `installationId` | string | no |  | Omit; the platform finds it or answers a connect link. |
| `displayName` | string | no |  | Human name; rename later with extension_workspace configure-project. |
| `description` | string | no |  | Short description. |
| `installCommand` | string | no | `"npm install"` | Install command. |
| `buildCommand` | string | no | `"npm run build -- --browser <browser>"` | Run as it is per browser (does not add --browser); `<browser>` substituted. |
| `outputDirectory` | string | no | `"dist/chrome"` | Build output; `<browser>` substituted. |
| `browsers` | array of "chrome" \| "edge" \| "firefox" | no | `["chrome"]` | Browsers to build. |
| `outputDirectories` | object | no |  | Per-browser outputDirectory overrides. |
| `projects` | array of object | no |  | Instead of project and repo: 1 to 10 (max 20) { project, repo } of one workspace. |
| `deviceCode` | string | no |  | Resume token; reuse re-reads the outcome. |
| `waitSeconds` | number | no |  | With deviceCode, seconds the call blocks for approval (0 to 900). |
| `login` | boolean | no | `true` | Store the minted login. |
| `api` | string | no |  | Platform URL; default EXTENSION_DEV_API_URL. |

## extension_publish

Publish a build on extension.dev: the link for testers, with a download and a run command for each browser; use it first to share or ship (no project yet: extension_project_create). On a public project, or a public channel, send testers the channel link (<workspace>.extension.dev/<project>/<channel>); a private build link expires.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "publish" \| "sync-captures" | no | `"publish"` | publish (default): the link; sync-captures: captures/<browser>/*.png to build pages (approval). |
| `browsers` | array of "chrome" \| "firefox" \| "edge" \| "safari" | no |  | sync-captures: browsers, one approval each. |
| `projectPath` | string | no |  | sync-captures: project root. |
| `approvalId` | string | no |  | sync-captures: approved approval id. |
| `project` | string | no |  | Stored login '<workspace>/<project>' when several exist. |
| `ttlHours` | number | no |  | Private link lifetime, hours (default 168). |
| `buildSha` | string | no |  | Build sha, 7 to 40 hex (an unreadable index echoes the sha back unverified); not with channel. |
| `channel` | string | no |  | Link a channel's newest build instead. |
| `force` | boolean | no |  | Publish despite failed checks. |
| `waitSeconds` | number | no |  | Seconds to wait for the result, 0 to 600 (default 180), and with approvalId for the approval. |
| `api` | string | no |  | Platform URL; default EXTENSION_DEV_API_URL. |

## extension_release_promote

Release a build to a channel on extension.dev. A release needs a workspace owner's token and approval of that exact release, every time (approval-required, then the same call with approvalId). Preview takes any build; Stable and every other channel take Stable builds. Tokens live 7 days.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "promote" \| "cut" \| "rollback" | no | `"promote"` | promote (default): channel to buildId; cut: version-bump pull request; rollback: previous build. |
| `project` | string | no |  | Stored login '<workspace>/<project>' when several exist. |
| `buildId` | string | no |  | Build commit sha (7+ characters). |
| `channel` | string | no |  | Target channel, e.g. stable, preview. |
| `level` | "patch" \| "minor" \| "major" | no |  | cut: version bump (default patch). |
| `sourceChannel` | string | no |  | Channel to promote from (inferred). |
| `browsers` | array of string | no |  | Browsers; default the build's index, which falls back to chrome alone. |
| `version` | string | no |  | Version label; cut: the exact version. |
| `releaseNotes` | string | no |  | Release notes, markdown. |
| `approvalId` | string | no |  | Approved approval id; every release needs a workspace owner's approval. |
| `waitSeconds` | number | no |  | Seconds to wait for the result, 0 to 600 (default 180), and with approvalId for the approval. |
| `api` | string | no |  | Platform URL; default EXTENSION_DEV_API_URL. |

## extension_release_status

Read where a project stands on extension.dev: channels, builds, store submissions and reviews, history, rollout, listings. Read-only.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `include` | array of "releases" \| "stores" \| "history" \| "runs" \| "rollout" \| "cut" \| "listing" | no | `["releases","stores"]` | releases: channels, builds; stores: submissions, reviews; history, runs: owner only; rollout: Chrome; cut: would a release PR build; listing: listings, gaps. |
| `since` | string | no |  | runs: earliest ISO date, within 30 days. |
| `refresh` | array of "chrome" \| "edge" \| "firefox" \| "safari" | no |  | stores: re-read these stores now (once per two minutes). |
| `waitSeconds` | number | no |  | refresh: wait 0 to 600 s for the check. |
| `submissionId` | string | no |  | stores: one submission by id or 8-character prefix. |
| `store` | "chrome" \| "firefox" \| "edge" \| "safari" | no |  | Only this store. |
| `releaseId` | string | no |  | One release, e.g. chrome-stable. |
| `workspace` | string | no |  | Workspace slug. |
| `project` | string | no |  | Project slug. |
| `projectPath` | string | no |  | Project root; picks its project. |
| `api` | string | no |  | Platform URL; default EXTENSION_DEV_API_URL. |

## extension_reload

Reload the extension's background, or a tab, over the control channel (allowControl); a background reload waits up to 5 s.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `context` | "background" \| "content" \| "page" | no | `"background"` | Background, or a content or page tab. |
| `tab` | number | no |  | content/page: the tab id. |
| `observe` | boolean \| string | no | `false` | true also answers value.observation: the surface's elements once it loaded and settled; a surface name (popup, options, sidebar...) reads that one. |
| `browser` | string | no |  | Session browser; required when several run. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |

## extension_screenshot

Take a .png of one surface, page or targetId in a live session (Safari: pages only); a closed surface is opened first, answering opened: true.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `browser` | string | no |  | Session browser; required when several run. |
| `context` | "page" \| "popup" \| "options" \| "sidebar" \| "newtab" \| "history" \| "bookmarks" | no | `"page"` | page: the tab url picks; else that open surface. |
| `url` | string | no |  | page: tab url substring. |
| `targetId` | string | no |  | A page's targetId (extension_open, or dom_snapshot listTargets); overrides url. |
| `width` | number | no |  | Viewport width (CSS px). |
| `height` | number | no |  | Viewport height (CSS px). |
| `deviceScaleFactor` | number | no |  | Pixel ratio, 0.5 to 4. |
| `store` | "chrome" \| "firefox" \| "edge" \| "safari" \| "all" | no |  | Store listing size, for extension_submit sync-listing. |
| `browserCapture` | boolean | no |  | Capture for extension_publish sync-captures. |
| `path` | string | no |  | A .png or folder/ under projectPath or an MCP root. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |

## extension_shares

List, create and revoke emulator preview links for a tester, and list and revoke build links (a build link or channel link comes from extension_publish). A revoke is permanent and needs an owner's approval.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `project` | string | no |  | Stored login '<workspace>/<project>' when several exist. |
| `kind` | "build-link" \| "preview" \| "both" | no | `"both"` | preview, build-link or both (default). |
| `tokenId` | string | no |  | revoke: a build link's tokenId. |
| `action` | "list" \| "create" \| "revoke" | no | `"list"` | list (default); create: share a build; revoke: one share, for good. |
| `buildId` | string | no |  | create: build commit sha. |
| `browser` | string | no |  | create: browser (default chrome). |
| `artifactId` | string | no |  | revoke: the gen_... id. |
| `url` | string | no |  | revoke: any URL of the share. |
| `approvalId` | string | no |  | revoke: approved approval id. |
| `projectPath` | string | no |  | Project root. |
| `status` | "all" \| "live" | no | `"all"` | all or live. |
| `limit` | number | no |  | 1 to 200 (default 100). |
| `api` | string | no |  | Platform URL; default EXTENSION_DEV_API_URL. |

## extension_start

Run the PRODUCTION build in a browser (extension_dev is for writing code); no hot reload or extension_logs. Bridge verbs need allowControl:true (Extension.js 4.1.34 or later; older is refused as engine-unsupported).

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root |
| `browser` | "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" \| "chromium-based" \| "gecko-based" \| "firefox-based" \| "webkit-based" | no | `"chrome"` | Target browser; *-based pairs with chromiumBinary or geckoBinary. |
| `build` | boolean | no | `true` | false: launch the existing dist. |
| `polyfill` | boolean | no | `true` | Cross-browser polyfill. |
| `port` | number | no |  | Engine --port; unused here. |
| `noBrowser` | boolean | no | `false` | Build only; the process ends with the build. |
| `allowControl` | boolean | no | `false` | Control channel for the bridge verbs. |
| `allowEval` | boolean | no | `false` | Enable extension_eval; implies allowControl. |
| `outputPath` | string | no |  | Unpacked directory to launch as is. |
| `replace` | boolean | no | `false` | Replace this project's session; else refused. |
| `isolated` | boolean | no | `false` | Throwaway headless run in a temp folder (4.1.36+); later calls and extension_stop use value.isolated.projectPath. |
| `wait` | boolean | no | `true` | Wait up to 45 s; false: call extension_wait. |
| `idleMinutes` | number | no |  | Idle minutes before it ends itself; 0 never; default 30 headless. |
| `profile` | string | no |  | Profile path; "false" reuses the real one. |
| `startingUrl` | string | no |  | URL opened on launch. |
| `chromiumBinary` | string | no |  | Chromium binary; browser still names the target family. |
| `geckoBinary` | string | no |  | Gecko binary; browser still names the target family. |
| `host` | string | no |  | Bind host (default 127.0.0.1). |
| `publicHost` | string | no |  | Host the browser dials, if not host. |
| `extensions` | array of string | no |  | Extra extensions to load. |
| `headless` | boolean | no |  | true: headless; false: a visible window; omitted: env decides. |

## extension_stop

Stop a dev or start session, naming the server and browser pid it ended. Call it when done.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | no |  | Project root; optional when exactly one project has a live session. |
| `browser` | string | no |  | Session browser; default the only live one. |
| `all` | boolean | no | `false` | Stop every session; across projects needs confirm. |
| `confirm` | boolean | no | `false` | With all: confirm the listed stop. |
| `includeOtherServers` | boolean | no | `false` | With all: include other servers' sessions. |

## extension_storage

Read or write one chrome.storage key from the background, over the control channel.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `action` | "get" \| "set" | yes |  | get reads a key or the whole area; set writes one. |
| `area` | "local" \| "sync" \| "session" \| "managed" | no | `"local"` | chrome.storage area. |
| `key` | string | no |  | Key to get or set. |
| `value` | any | no |  | Value to set; for null or "" use valueJson. |
| `valueJson` | string | no |  | Value as JSON text; not with value. |
| `observe` | boolean \| string | no | `false` | true also answers value.observation: the surface's elements once it loaded and settled; a surface name (popup, options, sidebar...) reads that one. |
| `browser` | string | no |  | Session browser; required when several run. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |

## extension_submit

Submit a platform build to the Chrome, Firefox, Edge and Safari stores through extension.dev. Start with extension_submit_check action:'preflight' and follow value.nextStep. A real submit needs a workspace owner's token and approval of that exact submission, every time: extension_submit_check asks, and this tool runs the approvalId. Uploads land least public (Chrome and Edge drafts, Firefox unlisted, Safari TestFlight) unless a saved store mode says otherwise. For a link use extension_publish.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "submit" \| "status" \| "preflight" \| "sync-listing" \| "cancel" \| "rollout" \| "release" \| "publish" \| "review" \| "configure-store" \| "connect" \| "first-submission" \| "mint-signing" | no | `"submit"` | Per action: 'preflight', 'status' and submit with dryRun true (the default) are read-only; submit with dryRun:false and no approvalId executes nothing either, it only asks for the owner's approval, as does the first call of any store act; the approved approvalId runs it. submit: buildSha to the stores. preflight: readiness checks. status: each store's word. sync-listing: listing from STORE.md. publish (alias review): draft to review. release (Safari): approved version on sale. cancel: withdraw from review. rollout: raise Chrome's staged rollout. configure-store: storeSettings. connect: page where the person gives the platform the key. first-submission: page for a first Chrome or Edge upload. mint-signing (Safari): register the bundle id, mint certificates and profiles. |
| `project` | string | no |  | Stored login '<workspace>/<project>' when several exist. |
| `browsers` | array of "chrome" \| "firefox" \| "edge" \| "safari" | no |  | Stores; submit, publish and sync-listing take several under one approval. |
| `buildSha` | string | no |  | Commit sha of a completed platform build (extension_builds). |
| `version` | string | no |  | Optional label; default the built manifest's version. |
| `dryRun` | boolean | no | `true` | true (the default) sends nothing and spends no approval or quota; false submits once approved and stops at the draft under the default modes. |
| `projectPath` | string | no |  | Project root; sync-listing needs it; nothing local is uploaded. |
| `approvalId` | string | no |  | From an approval-required answer, once approved; same arguments again. A real submission needs a workspace owner's approval every time. |
| `screenshots` | array of string | no |  | With sync-listing, PNG screenshots in projectPath; a wrong size or weight is answered with what the store accepts. |
| `useBuild` | string | no |  | With sync-listing, a completed build's sha to take icons from. |
| `detail` | boolean \| array | no |  | With preflight, true or a list like ["chrome", "safari.subtitle"] answers those rows in full. |
| `api` | string | no |  | Platform URL; default EXTENSION_DEV_API_URL. |
| `store` | "chrome" \| "firefox" \| "edge" \| "safari" | no |  | With cancel or rollout (default chrome), release (safari) or configure-store (required). |
| `storeSettings` | object | no |  | With configure-store, only what changes; a publishing mode asks approval; no credentials; Safari release mode is STORE.md's `- Release:` line. |
| `submissionId` | string | no |  | With cancel, publish or release, which submission; default the newest. |
| `buildNumber` | integer | no |  | Safari publish or release: TestFlight build number (default newest). |
| `deployPercentage` | number | no |  | With rollout, the new share of users, 1 to 100, above the current one. |
| `connectSession` | string | no |  | With connect, value.connectSession to wait on with waitSeconds. |
| `replace` | boolean | no |  | With connect, true replaces a working key; only when asked. |
| `waitSeconds` | number | no |  | Seconds to wait for the result, 0 to 600 (default 180), and with approvalId for the approval. |

## extension_submit_check

Read a store's state or ask for an approval, with extension_submit's inputs: preflight, status and a dry-run submit answer here; any other action only asks the owner's approval and answers value.approvalUrl, and the call carrying that approvalId runs through extension_submit. It executes nothing.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "preflight" \| "status" \| "submit" \| "publish" \| "review" \| "cancel" \| "rollout" \| "release" \| "sync-listing" \| "mint-signing" \| "configure-store" \| "connect" \| "first-submission" | no | `"submit"` | preflight, status, submit (a dry run unless dryRun:false, which only asks approval), or a store act to ask approval for. |
| `dryRun` | boolean | no | `true` | true (the default) reads only; false only asks the owner's approval of the real submit. |
| `project` | string | no |  | Same as in extension_submit. |
| `browsers` | array of "chrome" \| "firefox" \| "edge" \| "safari" | no |  | Same as in extension_submit. |
| `buildSha` | string | no |  | Same as in extension_submit. |
| `version` | string | no |  | Same as in extension_submit. |
| `projectPath` | string | no |  | Same as in extension_submit. |
| `screenshots` | array of string | no |  | Same as in extension_submit. |
| `useBuild` | string | no |  | Same as in extension_submit. |
| `detail` | boolean \| array | no |  | Same as in extension_submit. |
| `api` | string | no |  | Same as in extension_submit. |
| `store` | "chrome" \| "firefox" \| "edge" \| "safari" | no |  | Same as in extension_submit. |
| `storeSettings` | object | no |  | Same as in extension_submit. |
| `submissionId` | string | no |  | Same as in extension_submit. |
| `buildNumber` | integer | no |  | Same as in extension_submit. |
| `deployPercentage` | number | no |  | Same as in extension_submit. |
| `connectSession` | string | no |  | Same as in extension_submit. |
| `replace` | boolean | no |  | Same as in extension_submit. |
| `waitSeconds` | number | no |  | Same as in extension_submit. |

## extension_templates

Browse the template catalog or read a template's files. TypeScript is slug 'typescript', shadcn 'sidebar-shadcn'; AI templates tag 'ai'.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "list" \| "source" | no | `"list"` | list searches; source reads one template's files. |
| `slug` | string | no |  | source: the template, e.g. 'content-react'. |
| `files` | array of string | no |  | source: paths to read; omit for the listing. |
| `query` | string | no |  | list: keywords or a natural phrase. |
| `surface` | "content" \| "sidebar" \| "newtab" \| "background" | no |  | list: surface; for a popup use query:'action'. |
| `framework` | "react" \| "vue" \| "svelte" \| "preact" \| "" | no |  | list: UI framework; empty string is vanilla. |
| `tags` | array of string | no |  | list: tags, e.g. ['ai']. |
| `featured` | boolean | no |  | list: featured only. |
| `include` | array of "urls" | no |  | list: urls adds each row's repositoryUrl, catalogUrl and downloads. |

## extension_theme_verify

Verify a Chrome theme manifest headless: the colors Chrome would paint and the keys it discards.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `manifest` | object | no |  | Theme manifest object; or manifestPath. |
| `manifestPath` | string | no |  | Path to a theme manifest.json. |

## extension_try

Run a published extension.dev build in a fresh profile on this machine, no install, and screenshot it; warn the person about what it can reach. End with action:'close'; a local project is extension_dev.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `project` | string | yes |  | Published "<workspace>/<project>". |
| `version` | string | no |  | Version or build sha; default newest. |
| `browser` | string | no | `"chrome"` | chrome, edge or firefox; safari is refused. |
| `url` | string | no |  | http(s) page to open. |
| `headless` | boolean | no | `true` | false opens a usable window. |
| `action` | "run" \| "close" | no | `"run"` | run launches; close ends this project's tries. |
| `idleMinutes` | number | no |  | Idle minutes before it ends itself; 0 never; default 30. |

## extension_wait

Wait for a session to be ready, or for: "rebuild" after an edit; only after wait:false, a ready.status not "ready", or noBrowser; answers port, controlPort and cdpPort or rdpPort. A page condition is extension_eval until; never sleep in a shell.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root |
| `browser` | string | no |  | Session browser; required when several run. |
| `timeoutMs` | number | no | `45000` | Wait budget in ms, default 45000, clamped 1000-50000. |
| `timeout` | number | no |  | Deprecated alias of timeoutMs. |
| `for` | "ready" \| "rebuild" | no | `"ready"` | rebuild: the next compile and reload after an edit. |
| `since` | string | no |  | rebuild: ISO time a compile must follow. |

## extension_workspace

Read the workspace; change a project's settings. configure-project renames a project (displayName; slug and URLs stay). set-visibility public or a public liveChannel needs approval. Builds spend only on build branch pushes that change the root directory; docs-only pushes spend nothing.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "info" \| "projects" \| "usage" \| "settings" \| "set-visibility" \| "configure-project" \| "set-environment" | no | `"info"` | set-* and configure-project write. |
| `visibility` | "private" \| "public" | no |  | private: plain call under the owner's own token; public: approve page. |
| `settings` | object | no |  | configure-project: changed fields only (displayName, description, url, supportUrl, branch, rootDirectory, workspaceRoot, buildPullRequests, runWhatsNew, runExtensionExecutables, pullRequestComments, commitComments, autoCreateGitHubRelease, liveChannel); displayName renames the project. |
| `variables` | array of object | no |  | set-environment: to set. |
| `remove` | array of object | no |  | set-environment: to remove. |
| `approvalId` | string | no |  | For set-visibility public. |
| `include` | array of "team" \| "members" \| "tokens" \| "apps" \| "activity" \| "environment" \| "storeAccounts" | no |  | Read-only sections to add. |
| `workspace` | string | no |  | Slug. |
| `project` | string | no |  | Stored login; for settings, the project. |
| `api` | string | no |  | Platform URL; default EXTENSION_DEV_API_URL. |

## extension_workspace_create

Create a missing extension.dev workspace, before extension_project_create. The first call answers a code and URL, and whoever approves becomes its owner; call again with deviceCode.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `workspace` | string | yes |  | New slug (lowercase, digits, hyphens); your personal one exists. |
| `displayName` | string | no |  | Human name (default the slug). |
| `description` | string | no |  | Short description. |
| `developerUrl` | string | no |  | Public URL. |
| `deviceCode` | string | no |  | Resume token. |
| `api` | string | no |  | Platform URL; default EXTENSION_DEV_API_URL. |

