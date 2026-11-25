# MCP tools

Generated from the schemas the server registers (`src/index.ts`); do not edit by hand. Regenerate with `pnpm docs:tools`. A test fails when this file and the schemas disagree.

51 tools.

## extension_add_feature

Plan the surface before adding an options page, a popup, a side panel, a content script, a devtools panel, a new tab page or a background script. It lists manifest additions and new files and changes nothing; then validate the manifest, extension_build, extension_dev. New project: extension_create; templates: extension_templates; extension.dev: extension_project_create.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | The extension's folder (manifest.json or package.json). |
| `feature` | "sidebar" \| "popup" \| "options" \| "content-script" \| "background" \| "newtab" \| "devtools" | yes |  | Surface to plan; decides the manifest keys and files listed. |
| `framework` | "react" \| "vue" \| "svelte" \| "preact" \| "vanilla" | no | `"react"` | UI framework the planned files use. |

## extension_analyze

Analyze a built extension in dist/<browser>: total and shippable size, entry points, permissions and store checks. Answers sizes, reviewRisks and storeReadiness for what extension_build wrote; extension_builds_read and extension_builds_act cover builds on extension.dev. On a dev build it adds a note to run extension_build first.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | The extension's folder (manifest.json or package.json). |
| `browser` | string | no | `"chrome"` | Browser build to analyze. |
| `format` | "summary" \| "tree" \| "json" | no | `"summary"` | Accepted for compatibility; every value answers the same. |

## extension_approvals_read

List the open approvals this login asked for on extension.dev, or read one. Answers each approval with its id and status; extension_approvals_revoke revokes one.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "list" \| "status" | no | `"list"` | List (the default with no approvalId), read or revoke. |
| `approvalId` | string | no |  | The apr_ id; status and revoke need it. |
| `project` | string | no |  | '<workspace>/<project>' login to use when several are stored. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_approvals_revoke

Revoke an approval granted by mistake on extension.dev (owner token). Answers the revoked approval; extension_approvals_read lists them.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "revoke" | no | `"revoke"` | List (the default with no approvalId), read or revoke. |
| `approvalId` | string | no |  | The apr_ id; status and revoke need it. |
| `project` | string | no |  | '<workspace>/<project>' login to use when several are stored. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_assert

Run a test stage on an extension_dev or extension_start session: pass, fail, not ready (a precondition) or inconclusive per expectation, in one call; extension_dom_snapshot and extension_logs answer raw state instead. Debug-port checks: extension_start allowControl:true; content-script-injected and console-errors-empty: extension_dev only.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `expect` | array of object | yes |  | Each { assert: <id>, ...args }: background-worker-booted; surface-rendered {surface, selector?, minNodes?}; content-script-injected {url}; storage-key-present {key, area?, equals?, context?}; console-errors-empty {context?, since?, ignore?}; page-world-clean {url, pageGlobals?}; no-outside-requests {allow?, durationMs?}. |
| `browser` | string | no |  | Running session's browser; needed when several run. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |

## extension_auth_login

Sign in to an extension.dev project (a code at extension.dev/device, then deviceCode), or clear stored logins. Answers the login; extension_auth_read lists them. A login lasts a day, or what lifetime says (CI: Access tokens).

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "login" \| "logout" | no | `"login"` | logout deletes only the local login. |
| `project` | string | no |  | '<workspace>/<project>' from console.extension.dev (new: extension.dev/new). |
| `projectPath` | string | no |  | login: the directory whose GitHub origin names the project. |
| `projects` | array \| string | no |  | login: 1 to 20 existing projects of one workspace, at most 48 characters each, or "*" with workspace. |
| `workspace` | string | no |  | login with projects: "*": the workspace. |
| `deviceCode` | string | no |  | login: resume token. |
| `lifetime` | "hour" \| "day" \| "week" | no | `"day"` | login: how long it lasts. |
| `waitSeconds` | number | no |  | With deviceCode, seconds the call blocks for approval (0 to 900). |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_auth_read

List the extension.dev logins stored on this machine. Answers each login; value.tokenCheck.verdict is confirmed, refused or unavailable. extension_auth_login signs in or clears logins.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "status" | no | `"status"` | logout deletes only the local login. |
| `project` | string | no |  | '<workspace>/<project>' from console.extension.dev (new: extension.dev/new). |
| `projectPath` | string | no |  | login: the directory whose GitHub origin names the project. |
| `workspace` | string | no |  | login with projects: "*": the workspace. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_browsers_install

Install or remove a managed browser Extension.js launches; install downloads hundreds of MB in one blocking call, and uninstall never touches a system install. Answers the binary installed or removed; extension_browsers_read finds them.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "install" \| "uninstall" | no | `"install"` | list reads the managed cache. |
| `browsers` | array of "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" | no |  | detect: only these. |
| `browser` | "chrome" \| "chromium" \| "edge" \| "firefox" | no |  | install or uninstall: the managed binary. |
| `all` | boolean | no | `false` | uninstall: every managed binary. |

## extension_browsers_read

Find the browsers Extension.js launches: detect scans system and managed ones, list reads the managed cache. Answers each browser with its path and version; extension_browsers_install installs or removes managed ones.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "detect" \| "list" | no | `"detect"` | list reads the managed cache. |
| `browsers` | array of "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" | no |  | detect: only these. |
| `browser` | "chrome" \| "chromium" \| "edge" \| "firefox" | no |  | install or uninstall: the managed binary. |
| `all` | boolean | no | `false` | uninstall: every managed binary. |

## extension_build

Build an extension into dist/<browser>/ on this machine, one browser a call. Answers the output path, warnings and store review risks; extension_analyze reads what it wrote. Local only: extension_builds_read answers builds made on extension.dev, extension_builds_act rebuilds there. Safari needs macOS with Xcode.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | The extension's folder (manifest.json or package.json). |
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

## extension_builds_act

Rebuild, recheck or configure builds on extension.dev, or create or configure a channel. Answers the outcome; extension_builds_read reads builds, extension_build and extension_analyze work on this machine. A rebuild spends allowance; a push, only on the build branch when it changes the root directory ([skip build] pushes, docs-only, other branches spend nothing).

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "rebuild" \| "recheck" \| "configure" \| "create-channel" \| "configure-channel" \| "delete-channel" | yes |  | rebuild; recheck: rerun integrity; configure: buildSettings; create-, configure-channel; delete-channel: console only. |
| `buildId` | string | no |  | Commit sha, never the build number. rebuild: the commit to build (default the branch head); required for recheck. |
| `buildEnv` | "staging" \| "production" | no |  | rebuild: staging (default, Preview) or production (Stable, stores). |
| `buildSettings` | object | no |  | configure: per-browser changes, e.g. { firefox: { buildCommand: 'pnpm build' } }. |
| `approvalId` | string | no |  | Approved approval id. |
| `channel` | string | no |  | Channel name, max 40 chars. |
| `description` | string | no |  | Channel description, max 200 chars. |
| `color` | string | no |  | Channel color, #rrggbb. |
| `audience` | "public" \| "private" | no |  | private, or public (owner approval); default the project's visibility. |
| `browser` | string | no |  | recheck: chrome, edge, firefox or safari (default all). |
| `projectPath` | string | no |  | Project directory; picks its login. |
| `project` | string | no |  | '<workspace>/<project>' login to use when several are stored. |
| `waitSeconds` | number | no |  | Seconds to wait for the result (with approvalId, the approval), 0 to 600 (omitted: 180, no wait for the approval); the hosted server waits at most 45 and says so in warnings. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_builds_download

Download a verified package of an extension.dev build to this machine. Answers the saved path; extension_builds_read lists and reads builds.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "download" | no | `"download"` | list: recent builds, lastPush; get: one build; logs; download: a verified package. |
| `buildId` | string | no |  | Commit sha, never the build number; required for get, logs, download. |
| `browser` | string | no |  | chrome, edge, firefox, safari; download requires it and takes source. |
| `projectPath` | string | no |  | Project directory; picks its login. |
| `to` | string | no |  | download: directory (default the cache). |
| `project` | string | no |  | '<workspace>/<project>' login to use when several are stored. |
| `waitSeconds` | number | no |  | get: seconds to wait for a build's verdict (a rebuild or a push), 0 to 600 (omitted: 0); the hosted server waits at most 45 and says so in warnings. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_builds_read

Read builds made on extension.dev: list recent ones, get one, or read its logs. Answers rows with env and the channels holding each; extension_builds_download saves a verified package, extension_builds_act rebuilds, extension_build and extension_analyze work on this machine.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "list" \| "get" \| "logs" | no | `"list"` | list: recent builds, lastPush; get: one build; logs; download: a verified package. |
| `buildId` | string | no |  | Commit sha, never the build number; required for get, logs, download. |
| `browser` | string | no |  | chrome, edge, firefox, safari; download requires it and takes source. |
| `projectPath` | string | no |  | Project directory; picks its login. |
| `limit` | number | no |  | list: 1 to 50 (default 10). |
| `project` | string | no |  | '<workspace>/<project>' login to use when several are stored. |
| `waitSeconds` | number | no |  | get: seconds to wait for a build's verdict (a rebuild or a push), 0 to 600 (omitted: 0); the hosted server waits at most 45 and says so in warnings. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_create

Create a new extension from a template (extension_templates), plain JavaScript too; it may init git. Answers the project path; it is verified, so the next step is extension_dev, not a build. extension_add_feature adds to an existing project; extension_project_create puts a folder on extension.dev. Sends a draft_seeded event (off: readme Telemetry section).

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectName` | string | yes |  | Project directory name. Alias: name. |
| `parentDir` | string | no |  | Where to create it; default the MCP server process cwd. Aliases: parent, into. |
| `template` | string | no | `"typescript"` | Catalog slug, e.g. 'react'. |
| `install` | boolean | no | `true` | Install dependencies. |

## extension_dev

Run the extension in a browser with a dev build and hot reload while it is edited. Answers ready.status; ready.status "ready" means nothing else to call. extension_start runs the production build instead; extension_open shows a surface, extension_reload forces a reload, extension_wait waits for a rebuild and extension_stop ends the session. Safari needs macOS.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | The extension's folder (manifest.json or package.json). |
| `browser` | "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" \| "chromium-based" \| "gecko-based" \| "firefox-based" \| "webkit-based" | no | `"chrome"` | Target browser; *-based pairs with chromiumBinary or geckoBinary. |
| `port` | number | no |  | Dev server port; 0 picks a free one. |
| `noBrowser` | boolean | no | `false` | Start the dev server without launching a browser. |
| `polyfill` | boolean | no | `false` | Cross-browser polyfill. |
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

Search the Extension.js and extension.dev docs (free) for a WebExtension API, a manifest key, a permission or a browser difference. Answers matching pages with URLs and snippets to cite; extension_templates answers code to start from. An empty answer means the docs hold no match.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `query` | string | yes |  | Words or a question; an API, manifest key or permission name matches best. |
| `limit` | number | no | `5` | Most pages to answer. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_doctor

Diagnose a dev session leg by leg, each with its remediation. Answers each check and value.capabilities (WebGPU, cross-origin isolation); with no projectPath it checks Node.js, the Extension.js CLI and the template cache. extension_logs answers the extension's own console instead.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | no |  | Project root; omit for an environment check. |
| `browser` | string | no |  | Session browser; required when several run. |

## extension_dom_snapshot

Take a DOM snapshot of one open extension surface or targetId, or list what is open (listTargets on the debug port, listTabs). Answers counts, html or the visible interactive elements with selectors; extension_inspect answers a web page in depth, extension_element_act acts, extension_eval runs code, extension_logs answers console history.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `tab` | number | no |  | chrome.tabs id; else url, else the active tab. |
| `url` | string | no |  | content/page: the tab by url. |
| `tabUrl` | string | no |  | The tab by url from the target list. |
| `targetId` | string | no |  | Page targetId (extension_open, extension_dom_snapshot listTargets); wins over url. |
| `listTargets` | boolean | no | `false` | List page targets and return. |
| `listTabs` | boolean | no | `false` | List tabs with ids and return. |
| `context` | "content" \| "page" \| "popup" \| "options" \| "sidebar" \| "devtools" \| "newtab" \| "history" \| "bookmarks" | no | `"content"` | A closed surface is opened first (as extension_open does); the answer then says opened: true. |
| `include` | array of "summary" \| "html" \| "elements" | no | `["summary"]` | summary: counts. html: markup to maxBytes. elements: visible interactive elements with role, name, unique selector and state. |
| `maxBytes` | number | no | `32768` | Byte cap on the html. |
| `withConsole` | number \| boolean | no |  | Console lines: a count, or true for 50. |
| `browser` | string | no |  | Running session's browser; needed when several run. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |

## extension_element_act

Click or fill one element by CSS selector, or send trusted mouse and key input to a surface or page, with no caller code and no allowEval. Answers the element's state after the act; extension_element_read, extension_dom_snapshot, extension_inspect and extension_logs read, extension_eval runs code. Chromium only.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `action` | "click" \| "fill" \| "move" \| "press" \| "release" \| "type" \| "key" \| "scroll" | no | `"click"` | click (a real mouse press), fill, text, wait (until visible); move, press, release, type, key, scroll send trusted input. |
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
| `targetId` | string | no |  | Page targetId (extension_open, extension_dom_snapshot listTargets); wins over url. |
| `browser` | string | no |  | Running session's browser; needed when several run. |
| `timeout` | number | no |  | Timeout ms; wait polls until it (default 10000, max 30000). |

## extension_element_read

Read one element's text by CSS selector, or wait until it is visible, in a surface or page. Answers the text or the wait's outcome; extension_element_act clicks, fills and types. Chromium only.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `action` | "text" \| "wait" | no | `"text"` | click (a real mouse press), fill, text, wait (until visible); move, press, release, type, key, scroll send trusted input. |
| `selector` | string | no |  | CSS selector matching exactly one element (the point for input actions; focused before type and key). |
| `context` | "popup" \| "options" \| "sidebar" \| "devtools" \| "newtab" \| "history" \| "bookmarks" | no |  | An open surface (extension_open first). |
| `url` | string | no |  | A web page's tab by url. |
| `targetId` | string | no |  | Page targetId (extension_open, extension_dom_snapshot listTargets); wins over url. |
| `browser` | string | no |  | Running session's browser; needed when several run. |
| `timeout` | number | no |  | Timeout ms; wait polls until it (default 10000, max 30000). |

## extension_eval

Evaluate JavaScript in an extension's background, surface, content script, page or targetId. Answers the value; extension_element_act acts, extension_dom_snapshot and extension_inspect read, without code; extension_logs answers logs. Needs allowEval:true at launch (by hand: --allow-eval), the debug port included; runs carry a user gesture. Safari: pages only; extension_logs reads the background.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `expression` | string | yes |  | JavaScript expression; its value is the answer. |
| `context` | "background" \| "popup" \| "options" \| "sidebar" \| "devtools" \| "newtab" \| "history" \| "bookmarks" \| "content" \| "page" | no |  | Default page on a Chromium MV3 session, else background; a closed surface is opened first (as extension_open does). |
| `url` | string | no |  | content/page: the tab by url. |
| `tab` | number | no |  | chrome.tabs id to break a url tie. |
| `targetId` | string | no |  | Page targetId (extension_open, extension_dom_snapshot listTargets); wins over url. |
| `observe` | boolean \| string | no | `false` | true adds value.observation, the settled surface's elements; a surface name (e.g. popup) reads that one. |
| `browser` | string | no |  | Running session's browser; needed when several run. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |
| `until` | object | no |  | Re-run until the value is truthy; {} for the default interval and limit. |

## extension_inspect

Inspect a web page or targetId in a running session: its HTML, DOM, console and CSS selector counts, closed shadow roots included. Answers html, dom and console for a web page; extension_dom_snapshot answers an extension surface, extension_element_act acts on one element, extension_eval runs code, extension_logs answers console history. Firefox goes through the agent bridge and needs allowEval.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `url` | string | no |  | Navigate here first, or the url substring to pick. |
| `targetId` | string | no |  | Page targetId (extension_open, extension_dom_snapshot listTargets); wins over url. |
| `probe` | array of string | no |  | CSS selectors to count and sample. |
| `include` | array of "html" \| "summary" \| "meta" \| "dom_snapshot" \| "console" \| "extension_roots" | no | `["summary","meta","console"]` | Sections to answer; fewer sections, a smaller answer. |
| `browser` | string | no |  | Running session's browser; needed when several run. |
| `maxBytes` | number | no | `32768` | HTML byte cap (0 = none). |
| `deepDom` | boolean | no | `false` | Pierce closed shadow roots; other open roots are not crossed. |

## extension_list_extensions

List the extensions installed in a running session's browser, read-only; the project's own row has ownExtension:true. Answers id, name and version per row; extension_doctor diagnoses a session that fails.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `browser` | string | no |  | Running session's browser; needed when several run. |

## extension_logs

Read a dev session's console from every context in one timeline, or follow:true for live lines after the replayed ones. Answers past events with a seq to poll; extension_inspect and extension_dom_snapshot answer what shows now, extension_element_act acts, extension_eval runs code. Works on a `npx extension dev` run by hand (follow needs --allow-control there); not on extension_start.

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
| `follow` | boolean | no | `false` | Also collect live lines for followMs after the replayed ones. |
| `followMs` | number | no | `4000` | ms to collect live frames (500 to 15000). |
| `limit` | number | no | `200` | How many recent events. |

## extension_manifest_validate

Validate manifest.json against each browser: per-browser errors, permissions the code calls but lacks, and buildBlocking errors. Answers valid, errors, warnings and browserSupport; extension_build refuses the same errors, and a theme manifest is extension_theme_verify's. Reads files only.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `manifestPath` | string | no |  | Path to manifest.json; or projectPath. |
| `projectPath` | string | no |  | Project root (manifest at root or src/). |
| `browsers` | array of string | no | `["chrome","firefox","edge"]` | Browsers to validate against. |
| `browser` | string | no |  | One browser; alias for browsers:[browser]. |
| `include` | array of "similarTemplates" \| "storeReadiness" | no |  | similarTemplates adds up to five catalog templates with the same surfaces; storeReadiness adds the store listing lines. |

## extension_network_read

List the network stub rules of a Chromium session, or read which requests hit one or missed. Answers the rules and the requests seen; extension_network_stub adds or clears rules. Firefox is refused.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `action` | "list" \| "requests" | no | `"list"` | add a rule, list or clear the rules, or requests: which requests hit a rule or missed. |
| `url` | string | no |  | add: exact URL, or a glob with * and ?. |
| `browser` | string | no |  | Running session's browser; needed when several run. |

## extension_network_stub

Add a network stub rule to a Chromium session, or clear the rules. Answers the rules now in force; extension_network_read lists them and the requests seen. Rules last until extension_stop. Firefox is refused.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `action` | "add" \| "clear" | no | `"add"` | add a rule, list or clear the rules, or requests: which requests hit a rule or missed. |
| `method` | string | no |  | add: HTTP method; default ANY. |
| `url` | string | no |  | add: exact URL, or a glob with * and ?. |
| `status` | number | no | `200` | add: HTTP status to answer. |
| `body` | string | no |  | add: response text. |
| `json` | any | no |  | add: response as a JSON value; not with body. |
| `contentType` | string | no |  | add: Content-Type; default by body or json. |
| `browser` | string | no |  | Running session's browser; needed when several run. |

## extension_open

Open an extension surface or a url in a session, or replay the toolbar click, a menu item or a shortcut, over the control channel (by hand: --allow-control). A url opens in a background tab and answers target.targetId for extension_screenshot and readers. A replay carries no user gesture. extension_dev and extension_start launch, extension_reload reloads, extension_wait waits, extension_stop ends.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `surface` | "popup" \| "options" \| "sidebar" \| "devtools" \| "newtab" \| "history" \| "bookmarks" \| "action" \| "command" | no |  | Surface to open; action and command replay; devtools is Chromium only. |
| `name` | string | no |  | command: the chrome.commands name. |
| `menuItemId` | string | no |  | action: replay contextMenus.onClicked for this menu item id instead of the toolbar click (Chromium, over the debug port). |
| `panel` | string | no |  | devtools: panel title. |
| `waitMs` | number | no |  | devtools: ms to wait (default 15000). |
| `reload` | boolean | no | `false` | devtools: reload the inspected tab. |
| `url` | string | no |  | Url to open (a path resolves to the extension). |
| `foreground` | boolean | no | `false` | Raise the tab; only for a page the person must act on. |
| `newTab` | boolean | no | `false` | New tab even if one shows the url. |
| `tab` | number | no |  | With url: navigate this chrome.tabs id (not a tab position; from dom_snapshot listTabs: true); with menuItemId: the tab the click is for (default the active tab). |
| `asTab` | boolean | no | `false` | Render the surface in a tab. |
| `observe` | boolean \| string | no | `false` | true adds value.observation, the settled surface's elements; a surface name (e.g. popup) reads that one. |
| `browser` | string | no |  | Running session's browser; needed when several run. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |

## extension_preview_web

Preview a build in the web emulator; share:true returns a link that needs no install. Answers share.previewUrl; extension_publish answers a tester link with downloads, extension_shares_read lists, extension_shares_manage revokes. Content scripts run only on sample pages, a limit of the preview only. The preview://build default is for developing extension.dev itself.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | The extension's folder (manifest.json or package.json). |
| `project` | string | no |  | '<workspace>/<project>' login to use when several are stored. |
| `browser` | "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" | no | `"chrome"` | dist/<browser> to preview; Firefox view for Firefox. |
| `build` | boolean | no | `true` | Build first. |
| `distPath` | string | no |  | Preview this directory; implies build:false. |
| `hostUrl` | string | no |  | Local preview server origin. |
| `probe` | boolean | no | `true` | Check the artifact loads. |
| `open` | boolean | no | `false` | Also open it in a live session. |
| `openIn` | "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" | no |  | Session browser to open in. |
| `share` | boolean | no | `false` | Upload for share.previewUrl; metered against the workspace's allowance, and hands over the code. |

## extension_project_create

Create an extension.dev project from a folder (projectPath, uploaded, no push; again: re-seed and rebuild) or a GitHub repo, BEFORE extension_auth_login. The first call answers a URL a signed-in workspace member approves; resume with deviceCode and waitSeconds, the login is stored too. The first build spends one build of the workspace's monthly allowance, build command exactly as stored. extension_create, extension_templates and extension_add_feature work on local folders.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `project` | string | no |  | New '<workspace>/<project>'. |
| `projectPath` | string | no |  | Folder holding manifest.json, uploaded as it is (absolute or relative to the server cwd; default: the cwd when it holds manifest.json or extension.config.*). node_modules, dist, .git, .extension-dev, .zip, .crx, .xpi, .env*, key files and .gitignore entries stay out; 4 MB zipped at most. On an uploaded project with a login this re-seeds and rebuilds it after an approval; extension_builds_act rebuild rebuilds its stored tree without a new upload. |
| `repo` | string | no |  | GitHub '<owner>/<repo>' the platform reads the source from, never writes to; instead of projectPath. |
| `rootDirectory` | string | no |  | With repo: the folder inside it to build, e.g. 'examples/action'. |
| `workspaceRoot` | string | no |  | With repo: where dependencies install, '.' for the repo root; default rootDirectory. |
| `ref` | string | no |  | With repo: the branch, tag or full commit sha to build; default the repo's default branch. |
| `installationId` | string | no |  | Omit; the platform finds it or answers a connect link. |
| `displayName` | string | no |  | Human name; rename later with extension_workspace_configure configure-project. |
| `description` | string | no |  | Short description. |
| `installCommand` | string | no |  | Install command; left out, the platform reads it from the project. |
| `buildCommand` | string | no |  | Run as it is per browser (does not add --browser); `<browser>` substituted. Left out, the platform reads it from the project. |
| `outputDirectory` | string | no | `"dist/<browser>"` | Build output; `<browser>` substituted. |
| `browsers` | array of "chrome" \| "edge" \| "firefox" | no | `["chrome"]` | Browsers to build. |
| `outputDirectories` | object | no |  | Per-browser outputDirectory overrides. |
| `projects` | array of object | no |  | Instead of project and its source: 1 to 10 (max 20) { project, repo (and rootDirectory, workspaceRoot, ref) or projectPath } of one workspace, up to 10 per approval and at most 10 per hour, never split silently. |
| `deviceCode` | string | no |  | Resume token; reuse re-reads the outcome. |
| `waitSeconds` | number | no |  | With deviceCode, seconds the call blocks for approval (0 to 900). |
| `login` | boolean | no | `true` | Store the minted login. |
| `approvalId` | string | no |  | Re-seed approval. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_publish

Publish and share a build through extension.dev: answers the tester link, a page with a download and a run command for each browser (no project yet: extension_project_create). extension_preview_web: emulator links; extension_shares_manage revokes. On a public project, or a public channel, send testers the channel link (<workspace>.extension.dev/<project>/<channel>); a private build link expires.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "publish" \| "sync-captures" | no | `"publish"` | publish: the link; sync-captures: captures/<browser>/*.png to build pages (approval). |
| `browsers` | array of "chrome" \| "firefox" \| "edge" \| "safari" | no |  | sync-captures: browsers, one approval each. |
| `projectPath` | string | no |  | sync-captures: project root. |
| `approvalId` | string | no |  | Approved approval id. |
| `project` | string | no |  | '<workspace>/<project>' login to use when several are stored. |
| `ttlHours` | number | no |  | Private link lifetime, hours (default 168). |
| `buildSha` | string | no |  | Build sha, 7 to 40 hex (an unreadable index echoes the sha back unverified); not with channel. |
| `channel` | string | no |  | Link a channel's newest build instead. |
| `force` | boolean | no |  | Publish despite failed checks. |
| `waitSeconds` | number | no |  | Seconds to wait for the result (with approvalId, the approval), 0 to 600 (omitted: 180, no wait for the approval); the hosted server waits at most 45 and says so in warnings. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_release_promote

Release a build to a channel on extension.dev, cut a version-bump pull request, or roll a channel back. A release needs a workspace owner's token and approval of that exact release, every time. Preview takes any build; Stable and every other channel take Stable builds. Tokens live 7 days. Stores are extension_submit and extension_submit_check; extension_release_status answers where things stand.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "promote" \| "cut" \| "rollback" | no | `"promote"` | promote: channel to buildId; cut: version-bump pull request; rollback: previous build. |
| `project` | string | no |  | '<workspace>/<project>' login to use when several are stored. |
| `buildId` | string | no |  | Build commit sha (7+ characters). |
| `channel` | string | no |  | Target channel, e.g. stable, preview. |
| `level` | "patch" \| "minor" \| "major" | no |  | cut: version bump (default patch). |
| `sourceChannel` | string | no |  | Channel to promote from (inferred). |
| `browsers` | array of string | no |  | Browsers; default the build's index, which falls back to chrome alone. |
| `version` | string | no |  | Version label; cut: the exact version. |
| `releaseNotes` | string | no |  | Release notes, markdown. |
| `approvalId` | string | no |  | Approved approval id; every release needs a workspace owner's approval. |
| `waitSeconds` | number | no |  | Seconds to wait for the result (with approvalId, the approval), 0 to 600 (omitted: 180, no wait for the approval); the hosted server waits at most 45 and says so in warnings. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_release_status

Read where a project stands on extension.dev: channels, builds, store submissions and reviews, history, rollout and listings. Answers only the sections include names. Read-only; extension_release_promote changes a channel, extension_submit and extension_submit_check act on stores.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `include` | array of "releases" \| "stores" \| "history" \| "runs" \| "rollout" \| "cut" \| "listing" | no | `["releases","stores"]` | releases: channels, builds; stores: submissions, reviews; history, runs: owner only; rollout: Chrome; cut: would a release PR build; listing: listings, gaps. |
| `since` | string | no |  | runs: earliest ISO date, within 30 days. |
| `refresh` | array of "chrome" \| "edge" \| "firefox" \| "safari" | no |  | stores: re-read these stores now (once per two minutes). |
| `waitSeconds` | number | no |  | refresh: seconds to wait for the check, 0 to 600 (omitted: 0); the hosted server waits at most 45 and says so in warnings. |
| `submissionId` | string | no |  | stores: one submission by id or 8-character prefix. |
| `store` | "chrome" \| "firefox" \| "edge" \| "safari" | no |  | Only this store. |
| `releaseId` | string | no |  | One release, e.g. chrome-stable. |
| `workspace` | string | no |  | Workspace slug. |
| `project` | string | no |  | Project slug. |
| `projectPath` | string | no |  | Project root; picks its project. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_reload

Reload a running session's background, or one tab, through the control channel (allowControl); answers once it is back. extension_wait instead waits for the automatic rebuild after an edit; extension_dev and extension_start launch, extension_open opens a surface, extension_stop ends the session.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `context` | "background" \| "content" \| "page" | no | `"background"` | Background, or a content or page tab. |
| `tab` | number | no |  | content/page: the tab id. |
| `observe` | boolean \| string | no | `false` | true adds value.observation, the settled surface's elements; a surface name (e.g. popup) reads that one. |
| `browser` | string | no |  | Running session's browser; needed when several run. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |

## extension_screenshot

Take a .png of one surface, page or targetId in a live session; a closed surface is opened first, answering opened: true. Answers the file path and pixel size; extension_dom_snapshot answers the same surface as text. Safari: pages only.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `browser` | string | no |  | Running session's browser; needed when several run. |
| `context` | "page" \| "popup" \| "options" \| "sidebar" \| "newtab" \| "history" \| "bookmarks" | no | `"page"` | page: the tab url picks; else that open surface. |
| `url` | string | no |  | page: tab url substring. |
| `targetId` | string | no |  | Page targetId (extension_open, extension_dom_snapshot listTargets); wins over url. |
| `width` | number | no |  | Viewport width (CSS px). |
| `height` | number | no |  | Viewport height (CSS px). |
| `deviceScaleFactor` | number | no |  | Pixel ratio, 0.5 to 4. |
| `store` | "chrome" \| "firefox" \| "edge" \| "safari" \| "all" | no |  | Store listing size, for extension_submit sync-listing. |
| `browserCapture` | boolean | no |  | Capture for extension_publish sync-captures. |
| `path` | string | no |  | A .png or folder/ under projectPath or an MCP root. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |

## extension_shares_manage

Create an emulator preview link for a tester, or revoke a preview or build link, on extension.dev. Answers the link made or revoked; extension_shares_read lists them, extension_publish and extension_preview_web make them. A revoke is permanent and needs a workspace member's approval.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `project` | string | no |  | '<workspace>/<project>' login to use when several are stored. |
| `kind` | "build-link" \| "preview" \| "both" | no | `"both"` | build-link (extension_publish links), preview (emulator links) or both. |
| `tokenId` | string | no |  | revoke: a build link's tokenId. |
| `action` | "create" \| "revoke" | no | `"create"` | create: share a build; revoke: one share, for good. |
| `buildId` | string | no |  | create: build commit sha. |
| `browser` | string | no |  | create: browser (default chrome). |
| `artifactId` | string | no |  | revoke: the gen_... id. |
| `url` | string | no |  | revoke: any URL of the share. |
| `approvalId` | string | no |  | revoke: approved approval id. |
| `projectPath` | string | no |  | Project root. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_shares_read

List a project's emulator preview links and build links on extension.dev. Answers each link and its status; extension_shares_manage creates and revokes, extension_publish makes build links.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `project` | string | no |  | '<workspace>/<project>' login to use when several are stored. |
| `kind` | "build-link" \| "preview" \| "both" | no | `"both"` | build-link (extension_publish links), preview (emulator links) or both. |
| `action` | "list" | no | `"list"` | create: share a build; revoke: one share, for good. |
| `buildId` | string | no |  | create: build commit sha. |
| `browser` | string | no |  | create: browser (default chrome). |
| `projectPath` | string | no |  | Project root. |
| `status` | "all" \| "live" | no | `"all"` | list: all links, or live for only those still open. |
| `limit` | number | no |  | 1 to 200 (default 100). |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_start

Run the PRODUCTION build in a browser, as it ships; no hot reload or extension_logs. Bridge verbs need allowControl:true: extension_open, extension_reload and the readers (Extension.js 4.1.34 or later; older is refused as engine-unsupported). extension_dev runs the dev build; extension_wait follows wait:false; extension_stop ends it. Answers the session's ports.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | The extension's folder (manifest.json or package.json). |
| `browser` | "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" \| "chromium-based" \| "gecko-based" \| "firefox-based" \| "webkit-based" | no | `"chrome"` | Target browser; *-based pairs with chromiumBinary or geckoBinary. |
| `build` | boolean | no | `true` | false: launch the existing dist. |
| `polyfill` | boolean | no | `false` | Cross-browser polyfill. |
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

Stop a dev or start session and its browser. Answers the server and browser pid it ended. extension_dev and extension_start launch sessions; extension_reload reloads without ending one; extension_open and extension_wait need one running. all:true stops every session; across projects it needs confirm.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | no |  | Project root; optional when exactly one project has a live session. |
| `browser` | string | no |  | Session browser; default the only live one. |
| `all` | boolean | no | `false` | Stop every session; across projects needs confirm. |
| `confirm` | boolean | no | `false` | With all: confirm the listed stop. |
| `includeOtherServers` | boolean | no | `false` | With all: include other servers' sessions. |

## extension_storage_read

Read the extension's storage (chrome.storage or browser.storage) from its background, with no eval. Answers a key's value or the whole area; extension_storage_write sets a key. Needs the session's control channel (on by default in extension_dev).

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `action` | "get" | no | `"get"` | get: a key, or the whole area; set: one key, read back in value.readBack. |
| `area` | "local" \| "sync" \| "session" \| "managed" | no | `"local"` | local (this device), sync (the browser account), session (until restart) or managed (policy, read-only). |
| `key` | string | no |  | Key to read or write; omitted with get, the whole area answers. |
| `observe` | boolean \| string | no | `false` | true adds value.observation, the settled surface's elements; a surface name (e.g. popup) reads that one. |
| `browser` | string | no |  | Running session's browser; needed when several run. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |

## extension_storage_write

Write one key of the extension's storage (chrome.storage or browser.storage) from its background, with no eval. Answers the key read back in value.readBack; extension_storage_read reads. Needs the session's control channel (on by default in extension_dev).

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Project root of a running session: extension_dev, extension_start, or `npx extension dev\|start` by hand |
| `action` | "set" | no | `"set"` | get: a key, or the whole area; set: one key, read back in value.readBack. |
| `area` | "local" \| "sync" \| "session" \| "managed" | no | `"local"` | local (this device), sync (the browser account), session (until restart) or managed (policy, read-only). |
| `key` | string | no |  | Key to read or write; omitted with get, the whole area answers. |
| `value` | any | no |  | Value to set; for null or "" use valueJson. |
| `valueJson` | string | no |  | Value as JSON text; not with value. |
| `observe` | boolean \| string | no | `false` | true adds value.observation, the settled surface's elements; a surface name (e.g. popup) reads that one. |
| `browser` | string | no |  | Running session's browser; needed when several run. |
| `timeout` | number | no |  | Timeout ms (default 30000; Firefox 10000; debug port 15000). |

## extension_submit

Submit an extension.dev build to the Chrome, Firefox, Edge and Safari stores. It runs the call carrying an approvalId; extension_submit_check answers the preflight and asks the approval, extension_release_status answers reviews, extension_release_promote moves a channel. A real submit needs a workspace owner's token and approval of that exact submission, every time. Uploads land least public (Chrome and Edge drafts, Firefox unlisted, Safari TestFlight) unless a saved store mode says otherwise.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "submit" \| "status" \| "preflight" \| "sync-listing" \| "cancel" \| "rollout" \| "release" \| "publish" \| "review" \| "configure-store" \| "connect" \| "first-submission" \| "mint-signing" | no | `"submit"` | 'preflight', 'status' and submit with dryRun true are read-only; submit with dryRun:false and no approvalId executes nothing either, it only asks the owner's approval, as does the first call of any store act. submit: buildSha to the stores. preflight: readiness checks. status: each store's word. sync-listing: listing from STORE.md. publish (alias review): draft to review. release (Safari): approved version on sale. cancel: withdraw from review. rollout: raise Chrome's staged rollout. configure-store: storeSettings. connect: page where the person gives the platform the key. first-submission: page for a first Chrome or Edge upload. mint-signing (Safari): register the bundle id, mint certificates and profiles. |
| `project` | string | no |  | '<workspace>/<project>' login to use when several are stored. |
| `workspace` | string | no |  | connect: a workspace, for its shared account. |
| `browsers` | array of "chrome" \| "firefox" \| "edge" \| "safari" | no |  | Stores; submit, publish and sync-listing take several under one approval. |
| `buildSha` | string | no |  | Commit sha of a completed platform build (extension_builds_read). |
| `version` | string | no |  | Label; default the built manifest's version. |
| `dryRun` | boolean | no | `true` | true sends nothing and spends no approval or quota; false submits once approved and stops at the draft under the default modes. |
| `projectPath` | string | no |  | Project root, for sync-listing; nothing local is uploaded. |
| `approvalId` | string | no |  | Once approved, with the same arguments; a real submission needs a workspace owner's approval every time. |
| `screenshots` | array of string | no |  | sync-listing: PNG screenshots in projectPath. |
| `useBuild` | string | no |  | sync-listing: a completed build's sha for icons. |
| `detail` | boolean \| array | no |  | preflight: true, or ["chrome", "safari.subtitle"], answers those rows in full. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |
| `store` | "chrome" \| "firefox" \| "edge" \| "safari" | no |  | cancel, rollout (default chrome), release (safari), configure-store (required). |
| `storeSettings` | object | no |  | configure-store: only what changes; a publishing mode asks approval; no credentials; Safari release mode is STORE.md's `- Release:` line. |
| `submissionId` | string | no |  | cancel, publish, release: the submission; default newest. |
| `buildNumber` | integer | no |  | Safari publish or release: TestFlight build number (default newest). |
| `deployPercentage` | number | no |  | rollout: new share of users, 1 to 100, above the current one. |
| `connectSession` | string | no |  | connect: value.connectSession to wait on with waitSeconds. |
| `replace` | boolean | no |  | connect: true replaces a working key; only if asked. |
| `waitSeconds` | number | no |  | Seconds to wait for the result (with approvalId, the approval), 0 to 600 (omitted: 180, no wait for the approval; status, connect, first-submission: 0); the hosted server waits at most 45 and says so in warnings. |

## extension_submit_check

Check a store submission without sending it: preflight, status and a dry-run submit answer here; any other action records an approval request for the workspace owner and answers value.approvalUrl. extension_submit runs the call carrying that approvalId; extension_release_status answers review history, extension_release_promote releases a channel. Takes extension_submit's inputs.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "preflight" \| "status" \| "submit" \| "publish" \| "review" \| "cancel" \| "rollout" \| "release" \| "sync-listing" \| "mint-signing" \| "configure-store" \| "connect" \| "first-submission" | no | `"submit"` | The read, or the act to ask approval for. |
| `dryRun` | boolean | no | `true` | true reads only; false only asks the owner's approval of the real submit. |
| `project` | string | no |  | As in extension_submit. |
| `workspace` | string | no |  | As in extension_submit. |
| `browsers` | array of "chrome" \| "firefox" \| "edge" \| "safari" | no |  | As in extension_submit. |
| `buildSha` | string | no |  | As in extension_submit. |
| `version` | string | no |  | As in extension_submit. |
| `projectPath` | string | no |  | As in extension_submit. |
| `screenshots` | array of string | no |  | As in extension_submit. |
| `useBuild` | string | no |  | As in extension_submit. |
| `detail` | boolean \| array | no |  | As in extension_submit. |
| `api` | string | no |  | As in extension_submit. |
| `store` | "chrome" \| "firefox" \| "edge" \| "safari" | no |  | As in extension_submit. |
| `storeSettings` | object | no |  | As in extension_submit. |
| `submissionId` | string | no |  | As in extension_submit. |
| `buildNumber` | integer | no |  | As in extension_submit. |
| `deployPercentage` | number | no |  | As in extension_submit. |
| `connectSession` | string | no |  | As in extension_submit. |
| `replace` | boolean | no |  | As in extension_submit. |
| `waitSeconds` | number | no |  | As in extension_submit. |

## extension_submit_read

Read a project's store state through extension.dev: preflight answers what each store still needs, status the submissions. extension_submit_check asks approvals and extension_submit runs them.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "preflight" \| "status" | no | `"preflight"` | 'preflight', 'status' and submit with dryRun true are read-only; submit with dryRun:false and no approvalId executes nothing either, it only asks the owner's approval, as does the first call of any store act. submit: buildSha to the stores. preflight: readiness checks. status: each store's word. sync-listing: listing from STORE.md. publish (alias review): draft to review. release (Safari): approved version on sale. cancel: withdraw from review. rollout: raise Chrome's staged rollout. configure-store: storeSettings. connect: page where the person gives the platform the key. first-submission: page for a first Chrome or Edge upload. mint-signing (Safari): register the bundle id, mint certificates and profiles. |
| `project` | string | no |  | '<workspace>/<project>' login to use when several are stored. |
| `workspace` | string | no |  | connect: a workspace, for its shared account. |
| `browsers` | array of "chrome" \| "firefox" \| "edge" \| "safari" | no |  | Stores; submit, publish and sync-listing take several under one approval. |
| `buildSha` | string | no |  | Commit sha of a completed platform build (extension_builds_read). |
| `version` | string | no |  | Label; default the built manifest's version. |
| `projectPath` | string | no |  | Project root, for sync-listing; nothing local is uploaded. |
| `useBuild` | string | no |  | sync-listing: a completed build's sha for icons. |
| `detail` | boolean \| array | no |  | preflight: true, or ["chrome", "safari.subtitle"], answers those rows in full. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |
| `store` | "chrome" \| "firefox" \| "edge" \| "safari" | no |  | cancel, rollout (default chrome), release (safari), configure-store (required). |
| `submissionId` | string | no |  | cancel, publish, release: the submission; default newest. |

## extension_templates

Browse the template catalog or read a template's files. Answers slugs with surfaces and framework, or file contents; extension_create makes a project from one, extension_add_feature plans a surface in an existing project, extension_project_create puts a folder on extension.dev. Slugs: 'javascript' (plain), 'typescript', shadcn 'sidebar-shadcn'; AI templates tag 'ai'.

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
| `include` | array of "details" \| "urls" | no |  | list: details adds each row's tags, difficulty, featured and useCases; urls its repositoryUrl, catalogUrl and downloads. |

## extension_theme_verify

Verify a Chrome theme manifest, not an extension's: the colors Chrome paints and the keys it drops. Answers the resolved colors, the discarded keys and the checks left for a person in a browser; extension_manifest_validate covers extension manifests. Static: no browser runs.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `manifest` | object | no |  | Theme manifest object; or manifestPath. |
| `manifestPath` | string | no |  | Path to a theme manifest.json. |

## extension_try

Run a published extension.dev build in a fresh profile on this machine, no install, and screenshot it. Answers the opened page, its screenshot and the sites and permissions the extension can reach; extension_dev runs a local project. action:'close' ends it. Safari is refused.

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

Wait for a session to be ready, or for: "rebuild" for the next compile after an edit. Needed only after wait:false, a ready.status not "ready", or noBrowser from extension_dev or extension_start. Answers port, controlPort and the browser debugging port (cdpPort or rdpPort). extension_reload forces a reload, extension_open shows a surface, extension_stop ends the session.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | The extension's folder (manifest.json or package.json). |
| `browser` | string | no |  | Running session's browser; needed when several run. |
| `timeoutMs` | number | no | `45000` | Wait budget in ms, clamped 1000-50000; on starting, call again. |
| `timeout` | number | no |  | Deprecated alias of timeoutMs. |
| `for` | "ready" \| "rebuild" | no | `"ready"` | rebuild: the next compile and reload after an edit. |
| `since` | string | no |  | rebuild: ISO time a compile must follow. |

## extension_workspace_configure

Change a project's settings, visibility or build environment on extension.dev. configure-project renames a project (displayName; slug and URLs stay). set-visibility public or a public liveChannel needs approval. Answers what changed; extension_workspace_read reads.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "set-visibility" \| "configure-project" \| "set-environment" | no | `"set-visibility"` | set-* and configure-project write. |
| `visibility` | "private" \| "public" | no |  | private: plain call under the owner's own token; public: approve page. |
| `settings` | object | no |  | configure-project: changed fields only (displayName, description, url, supportUrl, branch, rootDirectory, workspaceRoot, buildPullRequests, runWhatsNew, runExtensionExecutables, pullRequestComments, commitComments, autoCreateGitHubRelease, liveChannel); displayName renames the project. |
| `variables` | array of object | no |  | set-environment: build variables to add or change. |
| `remove` | array of object | no |  | set-environment: build variables to delete. |
| `approvalId` | string | no |  | For set-visibility public. |
| `workspace` | string | no |  | Slug. |
| `project` | string | no |  | Stored login; for settings, the project. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_workspace_create

Create a missing extension.dev workspace, before extension_project_create; the personal workspace always exists. The first call answers a code and URL, and whoever approves becomes its owner; a second call with deviceCode finishes it.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `workspace` | string | yes |  | New slug (lowercase, digits, hyphens); your personal one exists. |
| `displayName` | string | no |  | Human name (default the slug). |
| `description` | string | no |  | Short description. |
| `developerUrl` | string | no |  | Public URL. |
| `deviceCode` | string | no |  | Resume token. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## extension_workspace_read

Read the extension.dev workspace: info, projects, usage and settings. Answers the sections asked; extension_workspace_configure changes settings, visibility and environment.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "info" \| "projects" \| "usage" \| "settings" | no | `"info"` | set-* and configure-project write. |
| `include` | array of "team" \| "members" \| "tokens" \| "apps" \| "activity" \| "environment" \| "storeAccounts" | no |  | Extra read-only sections to answer with the workspace. |
| `workspace` | string | no |  | Slug. |
| `project` | string | no |  | Stored login; for settings, the project. |
| `api` | string | no |  | Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev. |

## Old names

These names are not listed. A call to one still answers, with a warning that names the tools it became.

| old name | now |
| --- | --- |
| `extension_approvals` | `extension_approvals_read`, `extension_approvals_revoke` |
| `extension_auth` | `extension_auth_read`, `extension_auth_login` |
| `extension_browsers` | `extension_browsers_read`, `extension_browsers_install` |
| `extension_builds` | `extension_builds_read`, `extension_builds_download` |
| `extension_element` | `extension_element_read`, `extension_element_act` |
| `extension_network` | `extension_network_read`, `extension_network_stub` |
| `extension_shares` | `extension_shares_read`, `extension_shares_manage` |
| `extension_storage` | `extension_storage_read`, `extension_storage_write` |
| `extension_workspace` | `extension_workspace_read`, `extension_workspace_configure` |

