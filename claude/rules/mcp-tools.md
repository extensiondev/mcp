# MCP tools

Generated from the schemas the server registers (`src/index.ts`); do not edit by hand. Regenerate with `pnpm docs:tools`. A test fails when this file and the schemas disagree.

32 tools.

## extension_add_feature

Plan a new feature surface for an existing extension. This returns step-by-step instructions, the manifest additions to make, and reference templates from the extension.dev catalog. It modifies no files: apply the returned plan yourself.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root |
| `feature` | "sidebar" \| "popup" \| "options" \| "content-script" \| "background" \| "newtab" \| "devtools" | yes |  | Feature surface to add |
| `framework` | "react" \| "vue" \| "svelte" \| "preact" \| "vanilla" | no | `"react"` |  |

## extension_analyze

Analyze a BUILT extension on disk: file sizes, declared entry points, permissions, bundle composition, and store-readiness checks. This is static only: it reads dist/<browser> from the filesystem and never touches a browser, so build first with extension_build. Use extension_inspect for a running extension's live DOM and console.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root |
| `browser` | string | no | `"chrome"` | Browser build to analyze |
| `format` | "summary" \| "tree" \| "json" | no | `"summary"` |  |

## extension_assert

Run a test stage against a live dev session: state expectations and read one verdict for each, instead of reading a blob and hand-rolling the judgement. Every expectation comes back pass, fail or inconclusive, where inconclusive means this platform cannot cover the question today and the verdict says what would settle it. An inconclusive check is never a pass. Start the session with extension_dev; use extension_inspect or extension_logs when you want the raw reading instead of a verdict.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root (needs a live dev session) |
| `expect` | array of object | yes |  | One object per expectation, each { assert: <check id>, ...args }. background-worker-booted: no args. surface-rendered: surface (popup, options, sidebar, newtab, history, bookmarks), optional selector and minNodes. content-script-injected: url. storage-key-present: key, optional area (default local), equals, context. console-errors-empty: optional context (array), since (seq cursor), ignore (substrings). |
| `browser` | string | no |  | Session browser; defaults to this project's live session |
| `timeout` | number | no |  | Command timeout in ms. When omitted, the default depends on the route: 30000 through the dev session's control channel, 10000 over the Firefox debugger protocol, and 15000 per command over the Chromium debug port. |

## extension_auth

Sign this machine in to extension.dev, report that login, or clear it. Pass action:'status' (the default) to name the workspace and project the stored token is scoped to and when it expires, never the token itself; that identity comes from the stored token alone, and does not change with the current working directory or whichever project folder you are in. Status also asks the platform's whoami endpoint whether that credential actually resolves there: the answer rides value.server.verdict as confirmed, refused or unavailable (when the server could not be reached), with status logged-in for the first and last and refused-by-server for the second, so a local file claiming a login the server refused is never reported as logged in. Pass action:'login' for a two-phase flow: call with `project` to get a code plus a URL the user authorizes at extension.dev/device, then call again with the returned `deviceCode`. GitHub federation happens server-side, so no GitHub token lands on this machine. Minted tokens live at most 7 days, server-enforced, so CI must re-mint before expiry on the console's project settings, Access tokens page. Pass action:'logout' to delete the local credentials only (with `project`, just that project's login); the token stays valid server-side until it is revoked at the URL the response returns. Several logins live side by side on one machine, one per workspace/project, and status lists them all under `logins`. To sign in to several existing projects of one workspace at once, pass `projects` instead of `project`: one approval, one stored token per project.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "status" \| "login" \| "logout" | no | `"status"` |  |
| `project` | string | no |  | login: target project as '<workspace>/<project>'; the token is scoped to it. The slug pair is the console address bar: an existing project's page is console.extension.dev/<workspace>/<project>. Create one at extension.dev/new if none exists yet. Logins to several projects are all kept, the latest is the default; token-scoped tools take `project` to pick another. logout: remove only this project's login (omitted, every stored login goes). |
| `projects` | array of string | no |  | login: sign in to several existing projects of one workspace with one approval, instead of one approval each. 1 to 20 names as '<workspace>/<project>', all in the same workspace, each by its exact slug (lowercase letters and digits joined by single dashes, at most 48 characters), none twice. Pass it instead of `project`, never beside it. The approval page lists every name; one missing project refuses the whole list and mints nothing. Resume with the returned `deviceCode` and the same list. Every token is stored as that project's own login and all expire within 7 days, so the same call renews them together. |
| `deviceCode` | string | no |  | login: resume token from the prior call's `deviceCode`; omit on the first call. |
| `api` | string | no |  | Platform base URL (default EXTENSION_DEV_API_URL, else https://www.extension.dev) |

## extension_browsers

Find, install and remove the browsers Extension.js tooling can launch. Pass action:'detect' (the default) to scan both system-installed and managed browsers, and report each one's binary path, version, engine and debugger support. Pass action:'list' for the managed cache this tool downloads into, with sizes on disk. Pass action:'install' to download a managed binary: several hundred MB in one blocking call, so allow a generous client timeout. Pass action:'uninstall' to remove managed binaries; it never touches a system install.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "detect" \| "list" \| "install" \| "uninstall" | no | `"detect"` |  |
| `browsers` | array of "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" | no |  | detect: limit the scan to these. Omit to check all. |
| `browser` | "chrome" \| "chromium" \| "edge" \| "firefox" | no |  | install/uninstall: which managed binary. Required for install. |
| `all` | boolean | no | `false` | uninstall: remove every managed binary. |

## extension_build

Build a browser extension for production. The output lands in dist/<browser>/. Pass zip:true to also package a .zip for store submission. With browser:'safari' the build converts the extension into a macOS app through Xcode, and bundleId sets the identifier it ships under. The build refuses a manifest with build-blocking errors unless you pass skipValidation:true, because such a manifest yields a broken bundle the bundler itself never flags.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root |
| `browser` | "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" \| "chromium-based" \| "gecko-based" \| "firefox-based" \| "webkit-based" | no | `"chrome"` |  |
| `zip` | boolean | no | `false` | Create a .zip file for store distribution |
| `zipSource` | boolean | no | `false` | Include source code zip (required by some stores) |
| `zipFilename` | string | no |  | Custom .zip file name (defaults to name and version) |
| `polyfill` | boolean | no | `false` | Apply cross-browser polyfill |
| `silent` | boolean | no | `false` | Suppress build output |
| `mode` | "development" \| "production" \| "none" | no | `"production"` | Bundler mode override (also sets NODE_ENV) |
| `skipValidation` | boolean | no | `false` | Build even when extension_manifest_validate reports build-blocking errors. The build normally refuses: the engine itself stops only on missing scripts, icons, DNR rule files, default_locale and manifest_version, and ships a bundle over the rest. |
| `appName` | string | no |  | Safari targets only: name of the generated macOS app, which also names the Xcode scheme and the .app on disk. Defaults to the manifest name. |
| `bundleId` | string | no |  | Safari targets only: a reverse-DNS bundle identifier you own, such as com.acme.readinglist. Without one the app is packaged under a generated dev.extensionjs.* identifier derived from the app name, which two projects with the same name share, and the first team to register it takes it. |
| `macOsOnly` | boolean | no | `true` | Safari targets only: generate a macOS-only Xcode project. Pass false for a universal project that also targets iOS and iPadOS, which is what you want if the extension ships on iPhone or iPad. |
| `forceRegenerate` | boolean | no | `false` | Safari targets only: regenerate the Xcode project even when the engine considers it up to date. Use it when an earlier packaging run left the project broken. |

## extension_create

Create a browser extension project from a template in the extension.dev catalog. Call extension_templates first to see what is available. The scaffolder may initialize a git repository in the new project (with a first commit), and it also writes store metadata and a .gitignore of its own. Read the result's defaultsApplied block for the decisions this tool can read back: parent directory, template, package manager, target browser and whether a git repository was initialized by this call. After a successful scaffold this tool sends one telemetry event, draft_seeded (template slug, source and commit, a random install id, never a path or a name), to PostHog; the Telemetry section of this package's readme names the two environment variables that turn it off.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectName` | string | yes |  | Name of the extension project (used as directory name). Alias: name. |
| `parentDir` | string | no |  | Directory to create the project inside. Defaults to the MCP server process cwd, NOT the caller's cwd, so pass it whenever you care where the project lands. Aliases: parent, into. |
| `template` | string | no | `"typescript"` | Template slug from the extension.dev catalog (e.g. 'react', 'ai-claude', 'content-vue'). extension_templates discovers them. |
| `install` | boolean | no | `true` | Install dependencies after creation |

## extension_dev

Run the extension while you edit it: dev build, hot module replacement, and a browser with the extension loaded. Reach for this first when the ask is "run my extension". ONLY this tool unlocks the control channel that extension_storage, extension_reload, extension_open and extension_dom_snapshot need (allowControl:true) and the eval channel that extension_eval needs (allowEval:true, which implies allowControl, so you never need to pass both). Use extension_start instead to run the production build in a browser. The result carries the process info that extension_wait and extension_inspect need.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root |
| `browser` | "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" \| "chromium-based" \| "gecko-based" \| "firefox-based" \| "webkit-based" | no | `"chrome"` |  |
| `port` | number | no |  | Dev server port (0 for auto-assign) |
| `noBrowser` | boolean | no | `false` | Start the dev server without launching a browser |
| `polyfill` | boolean | no | `true` | Apply cross-browser polyfill |
| `profile` | string | no |  | Profile path, or "false" to reuse the real user profile. Omit for a throwaway one. |
| `startingUrl` | string | no |  | URL the browser opens on launch |
| `chromiumBinary` | string | no |  | Custom Chromium-based binary to launch; `browser` still names the target family the engine builds for (chromium-based when none is given). |
| `geckoBinary` | string | no |  | Custom Gecko/Firefox binary to launch; `browser` still names the target family the engine builds for (gecko-based when none is given). |
| `host` | string | no |  | Bind host, default 127.0.0.1. Use 0.0.0.0 in Docker or devcontainers. |
| `publicHost` | string | no |  | Host the browser dials for HMR and reload when it differs from the bind host |
| `extensions` | array of string | no |  | Extra extension paths or store URLs to load alongside the project |
| `replace` | boolean | no | `false` | Stop the live session for this projectPath first, reported as replacedSession. Without it a second call is refused rather than forking: two sessions fight over one profile and the newer browser dies on the lock. |
| `allowControl` | boolean | no | `false` | Enable the agent-bridge control channel that extension_storage/reload/open/dom_snapshot need |
| `allowEval` | boolean | no | `false` | Enable extension_eval (runs code in a context; writes a 0600 session token). Implies allowControl, so you never need to pass both. |
| `carrier` | boolean | no | `false` | Load the bundled Live Preview carrier beside your extension (Chromium only) so pages on preview.extension.dev, code.extension.dev and themes.extension.dev can pair with the session and stream its real-lane chrome.* trace. The carrier holds cookies, history, bookmarks, scripting and <all_urls>; the placed copy admits no localhost page unless the server sets the loopback switch named in the Live Preview carrier section of this package's readme, which exists for those apps' own dev servers. Written into the auto-loaded ./extensions folder, gitignored, and removed on extension_stop or extension_build: never part of a release. |

## extension_docs_search

Find pages in the Extension.js and extension.dev docs by keyword, each with a short excerpt. Use it before answering from memory on anything version-specific: a CLI flag, a manifest field across browsers, a store submission rule. Free and needs no login.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `query` | string | yes |  | What to look up, in a few words. |
| `limit` | number | no | `5` | How many pages to return, 1 to 8. |
| `api` | string | no |  | Platform base URL (default EXTENSION_DEV_API_URL, else https://www.extension.dev) |

## extension_doctor

Diagnose a dev session end to end: ready contract, dev-server process, control-port agreement, control channel, eval token, executor, browser liveness. This returns one {check, status, detail, remediation?} per leg, in dependency order. Read a 'skip' as blocked, not as a pass: it names the check that blocked it. A session started without allowControl comes back ok:true with status 'read-only', not as an error: its control channel is off by choice. Run this first when any act tool (storage, reload, eval, open) errors unexpectedly. Call it with no projectPath for a pre-flight environment check (node, the Extension.js CLI, the template cache) before any project exists.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | no |  | Path to the extension project root. Omit for a pre-flight environment check with no project. |
| `browser` | string | no |  | Browser session to diagnose. Defaults to the active dev session's browser for this project. |

## extension_dom_snapshot

Take a shallow structured DOM snapshot of one chosen surface through the agent bridge (localhost only; the snapshot itself needs no CDP, but listTargets and `tabUrl` resolution ask the browser directly and need the session's debug port: CDP page targets on Chromium, RDP tab descriptors on Firefox): element counts, extension roots, open shadow roots, optional byte-capped HTML, and optional recent console lines. This is the SURFACE PICKER: the only tool that reads an open extension surface by name (`context`: popup, options, sidebar, devtools) or an override page, the only one that takes a numeric chrome.tabs id, and the only one that enumerates what is open (listTargets for CDP targetIds and RDP tab actors, listTabs for numeric tab ids). An ambiguous `tabUrl` returns the candidates instead of guessing. It does not pierce closed shadow roots, run selector probes, or navigate: use extension_inspect for those, and for a deep read of an already-open web page. Start the session with allowControl:true (extension_dev).

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root (needs a live dev session) |
| `tab` | number | no |  | Numeric chrome.tabs id, only to disambiguate when several tabs match. With neither `tab` nor `url`, content/page target the active tab. |
| `url` | string | no |  | content/page: pick the tab by url (match pattern, then substring). Preferred over `tab`. |
| `tabUrl` | string | no |  | Target the tab whose URL contains this substring (case-insensitive; titles checked only when no url matches). Resolved against the live browser first: exactly one match proceeds, zero or several return the candidates instead of a guess. Alternative to `url`. |
| `listTargets` | boolean | no | `false` | Enumerate live page targets and return, ignoring the other args. The discovery path for `tabUrl`. Chromium: {targetId,url,title,type}. Firefox: RDP tab descriptors {actor,url,title,type}. Neither id is a numeric chrome.tabs id; for those use listTabs. |
| `listTabs` | boolean | no | `false` | Enumerate open tabs as {tabId,url,title} and return, ignoring the other args. Use when you need a numeric tab id. |
| `context` | "content" \| "page" \| "popup" \| "options" \| "sidebar" \| "devtools" \| "newtab" \| "history" \| "bookmarks" | no | `"content"` | content/page targets `url`, else the active tab; the rest must already be OPEN |
| `include` | array of "summary" \| "html" | no | `["summary"]` | What to include; html is byte-capped |
| `maxBytes` | number | no | `262144` |  |
| `withConsole` | number \| boolean | no |  | Also include recent console lines. A number is how many; true means 50. |
| `browser` | string | no |  | Session browser; defaults to this project's live session |
| `timeout` | number | no |  | Command timeout in ms. When omitted, the default depends on the route: 30000 through the dev session's control channel, 10000 over the Firefox debugger protocol, and 15000 per command over the Chromium debug port. |

## extension_eval

Evaluate an expression in a running extension context. Start the session with allowEval:true (extension_dev), which writes a 0600 session token; without that token every route of this tool, the debug port included, answers eval-disabled. Context defaults to 'background', except on a Chromium MV3 session (the default template) where it defaults to 'page', the active tab; pass context:'background' to evaluate in the service worker, which on Chromium goes over the debug port. Debug-port evaluates run with a user gesture, so gesture-gated APIs (permissions.request, sidePanel.open) can succeed here and still fail when the extension's own code calls them. For content and page, pass `url` to pick the tab, or omit both `url` and `tab` for the active tab; a numeric `tab` only disambiguates. Extension surfaces (popup, options, sidebar, devtools) and override pages (newtab, history, bookmarks) need no tab id but must already be open: open one with extension_open first, because a closed one returns an explicit error. On a Chromium MV3 session those pages, and context:'page' with a chrome-extension:// url, evaluate over CDP, the inspector path the extension page CSP does not govern; elsewhere they evaluate over the in-bundle relay. On Firefox a document whose content security policy forbids eval (the extension's own pages, or a site's) is evaluated over the debugger protocol instead, which takes one expression; a page inside the extension that is no declared surface (pages/*) is reached the same way by context:'page' and its moz-extension:// url once a tab shows it. Call extension_dom_snapshot with listTabs:true to enumerate {tabId, url, title}.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root (needs a live dev session) |
| `expression` | string | yes |  | JavaScript expression to evaluate in the target context |
| `context` | "background" \| "popup" \| "options" \| "sidebar" \| "devtools" \| "newtab" \| "history" \| "bookmarks" \| "content" \| "page" | no |  | Where to evaluate. Default background, except Chromium MV3 sessions default to page (the active tab). |
| `url` | string | no |  | content/page: pick the tab by url (match pattern, then substring). Preferred over `tab`. |
| `tab` | number | no |  | Numeric chrome.tabs id, only to disambiguate when several tabs match. |
| `browser` | string | no |  | Session browser; defaults to this project's live session |
| `timeout` | number | no |  | Command timeout in ms. When omitted, the default depends on the route: 30000 through the dev session's control channel, 10000 over the Firefox debugger protocol, and 15000 per command over the Chromium debug port. |

## extension_inspect

Inspect a running extension deeply over the browser's debugger protocol: full HTML (open shadow roots of #extension-root and [data-extension-root] hosts inlined; other shadow roots are not crossed by html, dom_snapshot or probe), DOM structure, content-script injection, console messages, and CSS selector queries through `probe`. This is the ONLY tool that pierces closed shadow roots (deepDom), runs selector probes, and navigates a tab to `url` before reading it. It reads a web or override page and picks the first inspectable target, or the first whose url contains `url`; it cannot address an extension surface by name and takes no chrome.tabs id. Use extension_dom_snapshot to choose which tab or which open surface (popup, options, sidebar, devtools) to read, or to enumerate what is open. Use extension_analyze for a built extension's files and sizes on disk. Chromium rides the Chrome DevTools Protocol and needs the session's debug port, not allowControl. Firefox is fully paired: summary, meta, html, dom_snapshot, extension_roots and probes ride the agent bridge and need allowEval:true, console rides the RDP watcher replay on engine 4.0.15 and later, and deepDom needs an MV2 session with host permissions for the target url, because the Firefox MV3 background CSP blocks bridge evals. This requires an active dev or start session.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root (needs a live dev session) |
| `url` | string | no |  | URL to inspect; the tab is navigated there first |
| `probe` | array of string | no |  | CSS selectors to query; returns counts and samples for each |
| `include` | array of "html" \| "summary" \| "meta" \| "dom_snapshot" \| "console" \| "extension_roots" | no | `["summary","meta","console"]` | What to include |
| `browser` | string | no |  | Session browser; defaults to this project's live session |
| `maxBytes` | number | no | `262144` | Truncate HTML output at this byte count (0 = unlimited) |
| `deepDom` | boolean | no | `false` | Pierce CLOSED shadow roots (open roots of the extension-root hosts are already inlined in html; other open roots are not read). Chromium: CDP DOM pierce. Firefox: a content-script walk via tabs.executeScript (MV2 only, needs host permissions for the target url); the answer says whether that context could see closed roots at all. |

## extension_list_extensions

List the extensions in the running dev browser: id, name, version, and, on Chromium, live contexts. This session's own extension carries ownExtension:true, with name and version from the ready contract even when the browser exposes no identity. Chromium rides the Chrome DevTools Protocol, so an entry needs at least one live context, and a dormant MV3 service worker may be absent until it wakes. Firefox rides the RDP root actor (listAddons, engine 4.0.15 and later), so entries are installed add-ons regardless of contexts, are marked temporarilyInstalled where relevant, and carry no contexts. Other extensions' contexts are never attached to or evaluated in. This requires an active dev or start session.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root (needs a live dev session) |
| `browser` | string | no |  | Session browser; defaults to this project's live session |

## extension_logs

Read or stream logs from every context of a running dev session (service worker, content scripts, popup, options, sidebar, devtools, pages) in one ordered timeline. This reads the same agent-bridge plane as the `extension logs` CLI: a one-shot returns the most recent matching lines from logs.ndjson, and follow:true connects to the live control channel, receives the broker's replay of its recent ring (up to 5,000 events, counted in value.replayed) and then the frames that arrive during followMs (value.live). This requires an active extension_dev session.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root (needs a live dev session) |
| `browser` | string | no |  | Which dist/extension-js/<browser>/ to read. Defaults to this project's live session, else chrome. |
| `level` | "off" \| "error" \| "warn" \| "info" \| "debug" \| "trace" \| "all" | no | `"all"` | Minimum severity; a level includes everything more severe. |
| `context` | array of "background" \| "content" \| "sidebar" \| "popup" \| "options" \| "devtools" \| "newtab" \| "history" \| "bookmarks" | no |  | Restrict to these contexts. Omit for all. |
| `signalsOnly` | boolean | no | `false` | Only structured dx.signal diagnostics (code/status/remediation), no plain console lines. |
| `since` | number | no |  | Only events with seq greater than this; the cursor for polling forward. |
| `url` | string | no |  | Only events whose url/hostname matches (glob or substring), e.g. https://shop.example/*. |
| `tab` | number | no |  | Only events from this tab id. |
| `follow` | boolean | no | `false` | Collect from the live control channel for a bounded window instead of reading the file. |
| `followMs` | number | no | `4000` | How long to collect live frames when follow=true (clamped 500–15000ms). |
| `limit` | number | no | `200` | How many of the most recent events to return. |

## extension_manifest_validate

Validate a manifest.json across browsers. This reports missing fields, invalid permissions, dangling file references, and cross-browser compatibility issues. Read buildBlocking for the errors that make extension_build refuse.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `manifestPath` | string | no |  | Path to manifest.json. Or pass projectPath and the manifest is located for you. |
| `projectPath` | string | no |  | Path to the extension project root; manifest.json is resolved from it (root or src/). Accepted in place of manifestPath. |
| `browsers` | array of string | no | `["chrome","firefox","edge"]` | Browsers to validate against |
| `browser` | string | no |  | Single browser to validate against; alias for browsers:[browser] to match the other tools. |

## extension_open

Open an extension surface, or replay an event, in a running session. Pass surface:'popup', 'options' or 'sidebar' to open a UI surface, or 'newtab', 'history' or 'bookmarks' to open the matching chrome_url_overrides page in a tab (always a tab, resolved by the server, never sent to the engine). On Chromium, when Chrome refuses the sidebar for lack of a user gesture, the server opens the real panel through a synthetic click on the extension's own page and says so in warnings; if that fails too it renders the sidebar document as a tab. Pass surface:'devtools' to open the browser's DevTools on a tab (the one `url` matches, else the first web page) and show the extension's panel there, picked by `panel` title when there are several: Chromium only, over CDP Target.openDevTools, headed or headless; the result names the panel document's url, which extension_eval reads with context 'page' and that url (the panel is no tab, so the tab-based readers do not reach it). Pass surface:'action' to trigger the toolbar action, which opens its popup or replays chrome.action.onClicked when there is none. Pass surface:'command' with `name` to replay a chrome.commands.onCommand shortcut. Note that action and command replay invoke your listener without a user gesture, so the gesture-derived activeTab grant does not apply; the engine's own frame is returned as is. Start the session with allowControl:true (extension_dev).

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root (needs a live dev session) |
| `surface` | "popup" \| "options" \| "sidebar" \| "devtools" \| "newtab" \| "history" \| "bookmarks" \| "action" \| "command" | no |  | Which surface to open or event to replay. |
| `name` | string | no |  | For surface 'command': the chrome.commands name to trigger. |
| `panel` | string | no |  | For surface 'devtools': the title the extension gave chrome.devtools.panels.create, when it registers more than one panel. Omitted, the extension's first panel is shown. |
| `waitMs` | number | no |  | For surface 'devtools': how long to wait for the panel to register after DevTools opens (default 15000, up to 120000). Extensions that create their panel on a page event need longer, or `reload`. |
| `reload` | boolean | no | `false` | For surface 'devtools': reload the inspected tab once DevTools is open, for extensions that create their panel only when the page reports to them on a load that starts with DevTools open (Preact Devtools). Discards the page state under test. |
| `url` | string | no |  | Navigate a real tab here instead of opening a surface, in a NEW tab unless `tab` names one (a blank or new-tab page is reused). An absolute url opens as given; a path with no scheme, such as pages/options.html, is resolved against the extension's own origin. Use for content-script test pages, or a surface as a page. |
| `tab` | number | no |  | With `url`: navigate this chrome.tabs id in place instead of opening a new tab (rides the engine's navigate verb, so the session needs allowControl: true). Without it an existing page is never taken over. |
| `asTab` | boolean | no | `false` | popup/options/sidebar: render the surface's document in a real tab instead of a popup window. This is how you inspect a surface HEADLESSLY, and it is applied automatically when a headless session refuses to open one. Same page and APIs, but no popup sizing and window.close() closes the tab. |
| `browser` | string | no |  | Session browser; defaults to this project's live session |
| `timeout` | number | no |  | Command timeout in ms. When omitted, the default depends on the route: 30000 through the dev session's control channel, 10000 over the Firefox debugger protocol, and 15000 per command over the Chromium debug port. |

## extension_preview_web

Preview an in-progress extension in the web emulator, with no real browser. This builds the project (unless build:false) and previews dist/<browser>. Pass share:true unless you are working inside the extension.dev monorepo: it uploads the build and returns a link anyone can open, with no install, sign-in or dev server, and it is the only lane that works from an npm install of this server. Sharing also serves the build as a zip, so it hands over the built code; read the share property before using it. The default lane instead returns a deep link over the dev-only preview://build scheme, which resolves only against a preview.extension.dev dev server on this machine, so it is for people developing extension.dev itself. Call extension_shares to list and revoke every link shared this way, so one never vanishes with this response.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root |
| `project` | string | no |  | Which stored login to use, as '<workspace>/<project>' (or a project slug that matches one login), when extension_auth has signed in to more than one project on this machine. Omitted, the most recent login is used, after EXTENSION_DEV_TOKEN when that is set. Named, it outranks EXTENSION_DEV_TOKEN. extension_auth (action: status) lists the stored logins. |
| `browser` | "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" | no | `"chrome"` | Which dist/<browser> output to preview. The emulator renders it as mocked Chrome either way. |
| `build` | boolean | no | `true` | Build first. false previews the existing dist/<browser> as-is. |
| `distPath` | string | no |  | Preview this built directory instead of dist/<browser> under projectPath. Implies build:false. |
| `hostUrl` | string | no |  | Origin of the running preview.extension.dev dev server (default http://localhost:3110). |
| `probe` | boolean | no | `true` | Fetch the surface's dev middleware first to confirm the artifact loads on the local host. With share:true it also checks the shared link the way a browser would, following the zip's redirects and asserting the final response allows the preview origin, and reports that as share.browserLoadable. |
| `open` | boolean | no | `false` | Also open the deep link in a running session's browser, in a focus-safe background tab. Needs a live extension_dev/extension_start session. |
| `openIn` | "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" | no |  | Which session's browser to open it in. Defaults to `browser`. |
| `share` | boolean | no | `false` | Upload the built dist and return a public link (share.previewUrl) that renders those exact bytes for anyone: no install, sign-in or dev server. Uploading is metered against your plan's allowance on extension.dev; left false, the result's share property says what the local deepLink needs, what share:true spends, and the exact call to get a shareable link. It also serves the build as a zip (share.zipUrl), so sharing hands over the code. Needs a token scoped to an extension.dev project (extension_auth or EXTENSION_DEV_TOKEN); without one you get a login hint and the local preview still succeeds. Live until share.expiresAt; DELETE share.revokeUrl to kill it sooner. Revocation is permanent, and re-sharing an unchanged build returns the same link unless it was revoked, so each share is also appended to the project's gitignored .extension.dev/shared-previews.json. |

## extension_project_create

Create an extension.dev project for an extension that does not have one yet, without opening the console. Use it right after extension_create and extension_build, once the extension's source is pushed to a GitHub repository, and BEFORE extension_auth: extension_auth can only log in to a project that already exists, and this tool is what brings that project into existence. Ask for nothing but the project slug and the repo; the platform finds the GitHub App installation on the approving account itself, and if there is none it returns a connect link to open. Two-phase, like login: the first call returns a code and a URL where a signed-in member of the workspace approves creating exactly this project; call again with the returned deviceCode to finish. The approval mints a provisioning grant that lives minutes, can only create the one named project, and is never stored on this machine. On success the platform creates the project and its mirror repository, and dispatches the first build when it can: the answer says in `firstBuild` whether one was dispatched and, when none was, why (no commits, no build workflow, a spent build allowance, a paused dispatch). Then run extension_auth (action: login) against the new project, and extension_publish to share it. To create several projects in one workspace under one approval, pass `projects` instead of `project` and `repo`: the approval page lists every name, each project is created by its own request, and each one's 7-day token is stored as that project's login, so no extension_auth call is needed afterwards. A list takes a few calls to finish: while projects remain the answer is status 'creating' with the same deviceCode to call again, and the grant is held in this server's memory only. One approval creates at most 10 projects, the cap the platform states in its login config, because it creates at most 10 per hour for one approving account; the next 10 can start in a new call once that limit allows. A longer list is refused before any approval is asked for, never split silently, and so is any list on a platform that does not advertise batch onboarding.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `project` | string | no |  | Target project as '<workspace>/<project>'. The workspace is the GitHub login of the approving user for personal workspaces; the project slug is the new project's name and must not exist yet. |
| `repo` | string | no |  | Source GitHub repository as '<owner>/<repo>'. The extension's code must be pushed there, and the owner must be the same GitHub account that approves the device code. |
| `installationId` | string | no |  | Optional override. Leave it out: the platform finds the extension.dev GitHub App installation on the approving account itself. Pass it only when an operator needs to name one explicitly, and it must still be an installation on that account or the platform refuses it. |
| `displayName` | string | no |  | Human name for the project. Defaults to the project slug. |
| `description` | string | no |  | Short project description. Defaults to a generic sentence naming the repo. |
| `installCommand` | string | no | `"npm install"` | Dependency install command the build runs first. |
| `buildCommand` | string | no | `"npm run build"` | Build command producing the extension bundle. |
| `outputDirectory` | string | no | `"dist/chrome"` | Directory the build writes the loadable extension into. With more than one browser, `<browser>` in the path becomes each browser's name (Extension.js writes `dist/<browser>`), and when it is left out every browser defaults to `dist/<browser>`. |
| `browsers` | array of "chrome" \| "edge" \| "firefox" | no | `["chrome"]` | Browsers the platform builds, each enabled with the same install and build command and its own output directory. Pass every browser the extension targets, for example ["chrome", "edge", "firefox"], so the project needs no console visit to go cross-browser. |
| `outputDirectories` | object | no |  | Per-browser output directory overrides, for example {"edge": "build/manifestv3"}. A browser named here wins over `outputDirectory`. |
| `projects` | array of object | no |  | Create several projects in one workspace under one approval, instead of `project` and `repo`. 1 to 10 entries (the platform's cap per approval; never more than 20), each { project: '<workspace>/<project>', repo: '<owner>/<repo>' }, all in the same workspace, each project named by its exact slug (lowercase letters and digits joined by single dashes, at most 48 characters), none twice and none existing yet. An entry may also carry displayName, description, installCommand, buildCommand, outputDirectory, browsers and outputDirectories for that project alone; the same inputs at the top level are the shared default for every entry that leaves them out. The answer carries one row per project: created and logged in, created with no token (run a batch extension_auth login), refused with the platform's code, or not attempted. A refusal on one project never hides the others. |
| `deviceCode` | string | no |  | Resume token from the prior call's `deviceCode`; omit on the first call. A batch returns the same deviceCode until every listed project has an answer. |
| `api` | string | no |  | Platform base URL (default EXTENSION_DEV_API_URL, else https://www.extension.dev) |

## extension_publish

Publish the project your stored token is scoped to (extension_auth, or EXTENSION_DEV_TOKEN) to extension.dev, and return its shareable URL. This is what "deploy" or "ship" an extension usually means; extension_submit is the separate store-review path. The target is the token's project: there is no projectPath, and no local file is uploaded. With several logins stored, pass `project` ('<workspace>/<project>') to pick which one; it outranks EXTENSION_DEV_TOKEN. For a public project the URL is the canonical public page and ttlHours does not apply. For a private one it is a fresh time-limited share link (?share=) whose lifetime is ttlHours.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `project` | string | no |  | Which stored login to use, as '<workspace>/<project>' (or a project slug that matches one login), when extension_auth has signed in to more than one project on this machine. Omitted, the most recent login is used, after EXTENSION_DEV_TOKEN when that is set. Named, it outranks EXTENSION_DEV_TOKEN. extension_auth (action: status) lists the stored logins. |
| `ttlHours` | number | no |  | Private-project share-link lifetime in hours, 1-168 (default 24). Ignored for public projects. |
| `buildSha` | string | no |  | Pin the URL to a build sha (7-40 hex chars). The platform rejects a sha missing from a readable build index; when its index cannot be read it echoes the sha back and a pin on a failed build is accepted, so value.buildSha is the platform's claim, not a verified build. extension_release_status lists the builds it knows. |
| `api` | string | no |  | Platform base URL (default EXTENSION_DEV_API_URL, else https://www.extension.dev) |

## extension_release_promote

Promote a built extension to a release channel (stable, preview, beta, …) on extension.dev, headless. This WRITES: it is the only verb that changes what a channel points at. It is auth-gated by your stored login (extension_auth) or a release token in EXTENSION_DEV_TOKEN, minted and revoked under project settings, Access tokens. Tokens live at most 7 days, so CI must re-mint before expiry. The project comes from the token; with several logins stored, `project` picks which one. Call extension_release_status to find a valid buildId. The status is 'promoted' only when the platform says every asked browser's release was dispatched and the channel pointer moved; 'promoted-partially' lists in its warnings what did not happen (a browser whose dispatch failed, a channel pointer that was not moved) and must not be repeated whole; 'promote-unconfirmed' means the platform's answer did not carry the result, so read extension_release_status before promoting again. Cutting a version-bump PR is not available headlessly, because it writes to your source repo and needs an interactive login.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `project` | string | no |  | Which stored login to use, as '<workspace>/<project>' (or a project slug that matches one login), when extension_auth has signed in to more than one project on this machine. Omitted, the most recent login is used, after EXTENSION_DEV_TOKEN when that is set. Named, it outranks EXTENSION_DEV_TOKEN. extension_auth (action: status) lists the stored logins. |
| `buildId` | string | yes |  | Build commit SHA to promote (a 7-char short SHA is fine) |
| `channel` | string | yes |  | Target release channel, e.g. stable, preview, beta |
| `sourceChannel` | string | no |  | Channel to promote from (optional; inferred otherwise) |
| `browsers` | array of string | no |  | Browsers to release. Optional: when omitted the platform reads the build's browsers from its index, and falls back to chrome alone when that index cannot be read, so pass them to be sure. |
| `version` | string | no |  | Version label for the release (optional) |
| `releaseNotes` | string | no |  | Release notes markdown (optional) |
| `approvalId` | string | no |  | The approval handle returned by a prior approval-required response. Promoting changes what a public channel serves and is not reversible in place, so when the platform's approval gate is on this needs a human approval: call once without this to get an approval id and URL, have a human approve at extension.dev, then call again with the same id. |
| `api` | string | no |  | Platform base URL (default EXTENSION_DEV_API_URL, else https://www.extension.dev) |

## extension_release_status

Read where a project stands on extension.dev, from the public registry (registry.extension.land). This is read-only: it dispatches nothing and promotes nothing. Pass include:'releases' for the release channels (channel to promoted build sha), recent builds, and a public build-page URL for each, which is how you find a valid sha for extension_release_promote, extension_submit or extension_publish. Pass include:'stores' for the per-store picture after an extension_submit (chrome, firefox, edge, safari): configured or not, the last credential health check, the last recorded submission, and the latest review status, read from stores/health.json, stores/status.json and stores/submissions.json. Both are included by default. This defaults to the logged-in project (extension_auth); pass workspace and project to read another. Private projects work when your stored login covers them. Registry state can lag the store dashboards by up to a polling interval.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `include` | array of "releases" \| "stores" | no | `["releases","stores"]` | Which sections to read. Both by default. |
| `workspace` | string | no |  | Workspace slug override (default: the stored login's). |
| `project` | string | no |  | Project slug override (default: the stored login's). |
| `api` | string | no |  | Platform base URL (default EXTENSION_DEV_API_URL, else https://www.extension.dev) |

## extension_reload

Reload a running extension's background context, or a tab. Start the session with allowControl:true (extension_dev). A background reload answers once the engine's ready.json shows the new background attached to the dev server again (value.reattached, value.reattachedMs), so the next read or assertion meets the new generation and not the gap between them; if it has not come back within the budget (timeout, at most 5 seconds) the answer is status reloading with the contract's own stamps.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root (needs a live dev session) |
| `context` | "background" \| "content" \| "page" | no | `"background"` |  |
| `tab` | number | no |  | For content/page: a specific tab id |
| `browser` | string | no |  | Session browser; defaults to this project's live session |
| `timeout` | number | no |  | Command timeout in ms. When omitted, the default depends on the route: 30000 through the dev session's control channel, 10000 over the Firefox debugger protocol, and 15000 per command over the Chromium debug port. |

## extension_shares

List and revoke the public preview links this token has shared, which is what extension_preview_web share:true hands out. Pass action:'list' (the default) for every artifact the logged-in project owns, with its artifactId, name, version, live or dead state, createdAt, expiresAt, revokedAt, size, previewUrl, zipUrl and revokeUrl, so a link whose response you lost is findable again. Each row carries owner and sharedBy as the platform returned them. Read attribution.ownership for who may revoke a share: 'project' means the workspace holds it and any member can pull it back, 'personal' means one person holds it alone, 'unknown' means no owner was disclosed. Read attribution.credit as credit only, never access; it names the publisher, and reads 'CLI token <id>' or 'not recorded' when no person can be named. Pass action:'revoke' with an artifactId, or with any URL of the share, to kill one permanently. Pass projectPath to reconcile against the project's own append-only .extension.dev/shared-previews.json, which is read and never rewritten: a share made on another machine shows as remoteOnly, a record with no live artifact as localOnly. That record is append-only, so localOnly is counted by distinct artifactId and a build re-shared unchanged is one share, not two; server.count and server.matched are share counts, while server.scanned counts records the platform read and is never a share count. This needs the same token as sharing (extension_auth or EXTENSION_DEV_TOKEN); without one, listing still returns the local record with a login hint.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `project` | string | no |  | Which stored login to use, as '<workspace>/<project>' (or a project slug that matches one login), when extension_auth has signed in to more than one project on this machine. Omitted, the most recent login is used, after EXTENSION_DEV_TOKEN when that is set. Named, it outranks EXTENSION_DEV_TOKEN. extension_auth (action: status) lists the stored logins. |
| `action` | "list" \| "revoke" | no | `"list"` | list reads every share this token owns; revoke permanently kills one and cannot be undone. |
| `artifactId` | string | no |  | Which share to revoke (the gen_... id from a share response or from action:"list"). Required for revoke unless url is given. |
| `url` | string | no |  | Any URL of the share to revoke (previewUrl, zipUrl, viewUrl, or revokeUrl). The artifact id is read out of it, so the link you sent someone is enough to pull it back. |
| `approvalId` | string | no |  | The approval handle returned by a prior approval-required response for a revoke. Revoking permanently burns a share and cannot be undone, so when the platform's approval gate is on this needs a human approval: call revoke once without this to get an approval id and URL, have a human approve at extension.dev, then call revoke again with the same id. Listing never needs it. |
| `projectPath` | string | no |  | Path to the extension project root. Reconciles the platform's answer against this project's .extension.dev/shared-previews.json record. Read-only. |
| `status` | "all" \| "live" | no | `"all"` | all (default) includes expired and revoked shares, which is what makes a dead link explainable; live returns only the links the platform reported resolving at list time (a 429 or 503 from the platform answers listed-local-only, which says nothing about any link). |
| `limit` | number | no |  | How many shares to return, 1 to 200 (platform default 100). A cut list comes back with truncated:true. |
| `api` | string | no |  | Platform base URL (default EXTENSION_DEV_API_URL, else https://www.extension.dev) |

## extension_start

Run the PRODUCTION build in a browser: build the project, serve it, and launch. There is no hot module replacement and no control channel, so your edits are not picked up and extension_eval, extension_storage, extension_reload, extension_open and extension_dom_snapshot cannot attach to this session. Use extension_dev while writing code, and this to check what actually ships. Pass build:false to launch an existing dist/<browser> without rebuilding, or outputPath to launch any prebuilt unpacked extension directory, one another toolchain produced included, which implies build:false.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root |
| `browser` | "chrome" \| "chromium" \| "edge" \| "brave" \| "opera" \| "vivaldi" \| "yandex" \| "firefox" \| "waterfox" \| "librewolf" \| "zen" \| "floorp" \| "safari" \| "chromium-based" \| "gecko-based" \| "firefox-based" \| "webkit-based" | no | `"chrome"` |  |
| `build` | boolean | no | `true` | Build before serving. false serves the existing dist/<browser> as-is and fails when there is none. |
| `polyfill` | boolean | no | `true` | Apply cross-browser polyfill (build only) |
| `port` | number | no |  | Passed to the engine as --port (0 for auto-assign). A production start serves nothing over it today; it matters only to a toolchain that reads it. |
| `noBrowser` | boolean | no | `false` | Build (or, with build:false, check the dist) without launching a browser. A production start serves nothing, so with no browser the engine process ends once the build does; read the result with extension_build rather than a session. |
| `outputPath` | string | no |  | An existing unpacked extension directory to launch as it is (a manifest.json at its root), for an artifact built by another toolchain or an exact release candidate. Implies build:false; projectPath still names the project the session belongs to. Relative paths resolve against projectPath. |
| `profile` | string | no |  | Profile path, or "false" to reuse the real user profile. Omit for a throwaway one. |
| `startingUrl` | string | no |  | URL the browser opens on launch |
| `chromiumBinary` | string | no |  | Custom Chromium-based binary to launch; `browser` still names the target family the engine builds for (chromium-based when none is given). |
| `geckoBinary` | string | no |  | Custom Gecko/Firefox binary to launch; `browser` still names the target family the engine builds for (gecko-based when none is given). |
| `host` | string | no |  | Bind host, default 127.0.0.1. Use 0.0.0.0 in Docker or devcontainers. |
| `publicHost` | string | no |  | Host the browser dials for HMR and reload when it differs from the bind host |
| `extensions` | array of string | no |  | Extra extension paths or store URLs to load alongside the project |

## extension_stop

Stop a session that extension_dev or extension_start is running: terminate the server and the browser it launched, and remove the live-preview carrier if extension_dev placed one. This covers extension_start build:false too, which the registry records as a preview session. Call it when you are done verifying, so sessions do not accumulate.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | no |  | Extension project root |
| `browser` | string | no |  | Browser of the session to stop. Defaults to the single live session for this project rather than assuming chrome. |
| `all` | boolean | no | `false` | Stop every known session across projects and browsers, found from this server's registry AND the on-disk markers written by this server or by servers that are no longer running, so it still works after an MCP restart. A marker owned by another MCP server that is still running is left alone and listed under skippedForeign unless includeOtherServers is true. It also takes back every live-preview carrier still recorded on this machine, including one in a project whose session was never stopped. projectPath/browser are then ignored. |
| `includeOtherServers` | boolean | no | `false` | With all: true, also stop sessions whose markers belong to another MCP server that is still running (the markers sit in a per-user directory every server shares). Off by default, since those sessions are someone else's. |

## extension_storage

Read or write chrome.storage in a running extension. Every call runs in the extension's background (the engine honours no context), so it proves nothing about what a content script or page can read. A set is read back and the answer says whether the stored value matches. Start the session with allowControl:true (extension_dev). Set one key per call: there is no bulk-object set.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root (needs a live dev session) |
| `action` | "get" \| "set" | yes |  | get reads a key (or the whole area); set writes a key |
| `area` | "local" \| "sync" \| "session" \| "managed" | no | `"local"` |  |
| `key` | string | no |  | Key to get or set |
| `value` | any | no |  | Value to set (any JSON value); required for action=set |
| `browser` | string | no |  | Session browser; defaults to this project's live session |
| `timeout` | number | no |  | Command timeout in ms. When omitted, the default depends on the route: 30000 through the dev session's control channel, 10000 over the Firefox debugger protocol, and 15000 per command over the Chromium debug port. |

## extension_submit

Submit a built extension for store REVIEW through extension.dev, which holds your store credentials and dispatches from your project's mirror CI: the Chrome Web Store, Firefox AMO, Edge Add-ons and the App Store (Safari). This is store review only. It does not push a build to the extension.dev platform, and it does not make a shareable link: that is extension_publish, which is what "deploy" or "ship" an extension almost always means. Reach for this only when the ask is explicitly a store submission. It defaults to a dry run that dispatches nothing: the platform verifies the token and project, finds the store workflow, reads the build from its index when that index is readable, reads store health itself and adds a Safari plan verdict; this tool re-reads the per-store health rows beside it. The dry run does not run the owner gate, the approval, the build quota, the dispatch pause or the submission-mode check, which the real run does first. Pass dryRun:false to actually submit, which is irreversible: only the workspace owner who issued the token may, and it dispatches the store workflow; a Chrome or Edge store with no saved submission mode is uploaded as a draft (absent_mode: safe) and does not enter review. A real submission answers 'submitted' only when the platform recorded a submission for every store asked; 'submitted-partially' names the stores it did not record, which are the only ones to submit again; 'submit-unconfirmed' means no usable answer came back, so read extension_release_status before submitting again, because a second call submits a second time. The project comes from your token (extension_auth or EXTENSION_DEV_TOKEN; tokens live at most 7 days, so CI must re-mint from the console's Access tokens page); with several logins stored, `project` picks which one. Store credentials are never arguments, and no local file is uploaded. Call extension_release_status for valid shas, and, after a real submission, for the recorded outcome and review state.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `project` | string | no |  | Which stored login to use, as '<workspace>/<project>' (or a project slug that matches one login), when extension_auth has signed in to more than one project on this machine. Omitted, the most recent login is used, after EXTENSION_DEV_TOKEN when that is set. Named, it outranks EXTENSION_DEV_TOKEN. extension_auth (action: status) lists the stored logins. |
| `browsers` | array of "chrome" \| "firefox" \| "edge" \| "safari" | yes |  | Stores to submit to. |
| `buildSha` | string | yes |  | The built commit SHA to submit. It needs a completed build in the project's build index; an unknown sha is rejected. |
| `channel` | string | no |  | Release channel to submit from (default stable). |
| `version` | string | no |  | Version label for the submission record (optional). |
| `dryRun` | boolean | no | `true` | Preflight only. Pass false to actually dispatch (irreversible, enters store review). |
| `projectPath` | string | no |  | Path to the extension project root, read only for the local STORE.md advisory check. Nothing local is uploaded; without it the check falls back to the server's working directory. |
| `approvalId` | string | no |  | The approval handle returned by a prior approval-required response for a real submission. A real submission (dryRun:false) is irreversible and needs a human approval when the platform's approval gate is on: call once without this to get an approval id and URL, have a human approve at extension.dev, then call again with the same id. A dry run never needs it. |
| `api` | string | no |  | Platform base URL (default EXTENSION_DEV_API_URL, else https://www.extension.dev) |

## extension_templates

Browse the extension.dev template catalog. Pass action:'list' (the default) to search and filter it and get metadata per template. Pass action:'source' with a `slug` to read one template's files, for learning a pattern before building something similar. Read `framework` as the UI framework only, never the language: TypeScript and JavaScript templates live under slugs ('typescript', 'content-typescript'), shadcn is a React variant ('sidebar-shadcn'), and provider AIs carry the 'ai' tag ('ai-chatgpt', 'ai-claude'). Reach those through query, tags or slug.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `action` | "list" \| "source" | no | `"list"` |  |
| `slug` | string | no |  | source: which template to read (e.g. 'ai-claude', 'content-react'). Required for source. |
| `files` | array of string | no |  | source: paths to read (e.g. ['src/manifest.json']). Omit for the file listing. |
| `query` | string | no |  | list: keyword search over slug, description, tags and useCases. Ranks by word matches, so a natural phrase works. |
| `surface` | "content" \| "sidebar" \| "newtab" \| "background" | no |  | list: filter by surface. For a popup/action starter use query:'action', not a surface. |
| `framework` | "react" \| "vue" \| "svelte" \| "preact" \| "" | no |  | list: UI framework filter (empty string = vanilla JS). |
| `tags` | array of string | no |  | list: filter by tags, e.g. ['ai', 'chat']. |
| `featured` | boolean | no |  | list: only featured templates. |

## extension_theme_verify

Verify a Chrome theme manifest before it ships. This settles the four-leg WYSIWYG contract (app-shows == manifest-says == chrome-paints, plus chrome-accepts) as far as is possible headless: it derives every color current Chrome would paint from the manifest through the transcribed Chromium resolver, and classifies each problem as D1 fabrication, D3 parity gap, or D4 acceptance gap (keys Chrome silently discards: dead legacy, incognito, unknown, out-of-range). It verifies only, and never authors or mutates a theme. The app-rendered and real-pixel legs need a browser, so they come back as needsAttended pointing at the assert:theme and install-parity harnesses, never as passed.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `manifest` | object | no |  | The Chrome theme manifest object (with a `theme` block). Pass this or manifestPath. |
| `manifestPath` | string | no |  | Path to a theme manifest.json (or a { manifest } seed wrapper). Read in place of the inline manifest. |

## extension_wait

Wait for a running dev or start session to be ready. This polls the ready.json contract and reports compiled (the compiler finished), browserAttached (the runtime executor connected), and guestLoaded (the browser's own target list shows your extension). Read guestLoaded as the trustworthy load signal: it catches a silently rejected --load-extension that leaves ready.json stamped attached with empty logs. It is null when it could not be checked, for example a gecko session with no CDP port. Every result reports budgetMs and elapsedMs; on status 'timeout', call again to keep waiting on the same contract. In a noBrowser session this returns as soon as the compile lands, instead of waiting for a browser that will never attach. Ports come from the contract, so they match what the server actually bound.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `projectPath` | string | yes |  | Extension project root |
| `browser` | string | no |  | Session browser; defaults to this project's live session |
| `timeoutMs` | number | no | `45000` | Wait budget for this call. Default 45000, clamped to 1000-50000 so one call stays under the client's 60s request timeout. On timeout, call again to keep waiting. |
| `timeout` | number | no |  | Deprecated alias of timeoutMs, which wins when both are given. |

## extension_workspace_create

Create an extension.dev workspace that does not exist yet, without opening the console. Use it before extension_project_create when the project's workspace is not there: project creation can only target an existing workspace, and this tool is what brings one into existence. Two-phase, like login: the first call returns a code and a URL where a signed-in GitHub user approves creating exactly this workspace and becomes its owner; call again with the returned deviceCode to finish. Check `ownerGithubLogin` in the answer: whoever approved the code owns the workspace. The approval mints a grant that lives minutes, can only create the one named workspace, names no project, and is never stored on this machine. Then run extension_project_create against '<workspace>/<project>'.

| input | type | required | default | description |
| --- | --- | --- | --- | --- |
| `workspace` | string | yes |  | Slug of the new workspace, lowercase letters, digits and hyphens, no slash. It must not exist yet; a personal workspace (the GitHub login) already exists for every signed-in user, so this is for a shared or organization-style workspace. |
| `displayName` | string | no |  | Human name for the workspace. Defaults to the slug. |
| `description` | string | no |  | Short workspace description. Optional. |
| `developerUrl` | string | no |  | Public URL for the workspace. Optional. |
| `deviceCode` | string | no |  | Resume token from the prior call's `deviceCode`; omit on the first call. |
| `api` | string | no |  | Platform base URL (default EXTENSION_DEV_API_URL, else https://www.extension.dev) |

