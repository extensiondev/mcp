# Changelog

## 10.11.4

Built on Extension.js 4.1.33.

- `extension_manifest_validate` no longer tells a Firefox MV2 manifest to port `background.scripts` to `chromium:service_worker` when the manifest already declares one, nested under `background` or as a top-level `chromium:background`, and no longer asks for `chromium:action` when one is declared. A Firefox MV3 manifest whose only background is `background.scripts` now hears that Chromium MV3 runs only a service worker. The `newtab-react` template drew the port advice on every Firefox check.
- `extension_browsers` reports one version per browser, read from the binary itself: the bundle's `Info.plist` or `application.ini` first (the way the engine's `firefox-location2` reads it), then `--version`, keeping a prerelease suffix such as `a1`, `b3` or `esr`. `detect` used to cut Nightly's "159.0a1" to "159.0", and `list` reported no version at all, so an agent compared the cache folder `mac_arm-nightly_158.0a1` of a self-updated Nightly with "159.0" and called it a mismatch. `list` now carries `version` beside `binaryPath`, and the folder name stays only in the path.
- `extension_list_extensions` on Chromium lists every extension installed in the session profile, not only the ones with a live CDP target: an extension whose MV3 service worker has gone dormant is listed with `running: false` and no contexts, and live ones carry `running: true`. Component extensions (the PDF viewer) stay out.
- `extension_storage` says when the project's source manifest does not declare the `storage` permission: the answer carries `manifestDeclaresStorage: false` and a warning that the dev session's control channel answered anyway while the extension's own code gets no `chrome.storage` without it.
- The plugin's CLAUDE.md template table lists `ai-chatgpt` under Sidebar beside `ai-claude`; it sat under Action popup, and every AI template is a side panel.
- `extension_theme_verify` names steps a user can take for the two legs it cannot settle headless: open the theme in the editor at themes.extension.dev, and run it with `extension_dev` to look at the browser. It named two internal harnesses (`assert:theme`, `install-parity`) that exist only in the maintainers' repository, and agents read them out as next steps.

## 10.11.3

Built on Extension.js 4.1.33.

- `extension_assert`'s `surface-rendered` check on `newtab` finds the override where Chrome lists it: an overridden new tab page is a `chrome://newtab/` target, not `chrome-extension://<id>/newtab.html`, so the check failed with "nothing is rendering it" while the page was on screen. A `chrome://newtab/` page counts only when it answers with this extension's own `chrome.runtime.id`, so Chrome's default page or another extension's override still fails.

## 10.11.2

Built on Extension.js 4.1.33.

- `extension-create` and `extension-install` move from 4.1.32 to 4.1.33, the version `extension-develop` already ran on, so the nightly engine-pin check reads all three engines as current.
- CI runs the canary cell on stable when npm's canary tag is behind it (the tag sat on 4.1.31-canary while stable was 4.1.33), so a stale canary no longer reds the required `verify (canary)` check on a golden the pinned engine already changed.
- The generated tool reference moves from `claude/rules/mcp-tools.md` to `claude/reference/mcp-tools.md`. At 71k characters it restates the schemas the server already sends, and anyone who copied `claude/rules` into a project as Claude Code rules loaded it into every session; two such copies on one path (a workspace folder and a project in it) crossed Claude Code's 150k instruction limit and painted a warning naming the file. `claude/rules` now holds only the two hand-written rules, and a test keeps that folder under 10k characters.
- `extension_start` and `extension_wait` on a production session say what they read and never point at a file: the answer carries `browserPid` and `browserAlive` from the contract the launcher stamps, `extensionLoaded: null` with `loadEvidence` saying plainly that a production launch opens no debug port and carries no dev bridge (so `extension_logs` has no stream for it and the load itself is unread), and names `extension_dev` for a proven load; the `/var/folders/.../session.log` path left the answer.
- `extension_stop` says what it ended: the answer carries `serverGone`, the `browserPid` the launcher recorded in `ready.json` and `browserGone`, and its detail reads "Ended: the server (pid N) is gone; the browser the launcher recorded (pid M) is gone" (or that no browser pid was recorded, or that a build-only session launched none); a browser still alive keeps `stopped` false.
- `extension_wait` answers with every port the session bound, read from the contract: `port` (the dev server), `controlPort` (the control channel) and `cdpPort` (the browser's debug port on Chromium) or `rdpPort` (on Gecko), or `debugPortNote` when the session opened none; `extension_dev`'s ready block inherits them.
- `extension_add_feature`'s description is the trigger: it names the asks it answers (add an options page, a popup, a side panel, a content script, a devtools panel, a new tab page or a background script), says it plans the surface and the agent writes what the plan says, and hands the follow-up to the manifest check and `extension_dev`.

## 10.11.1

Built on Extension.js 4.1.33.

- The engine pin moves from 4.1.32 to 4.1.33, the release whose bundled
  javascript template matches the examples corpus and whose eval ok golden
  answers the bare value the CLI answers (#834).
- The golden-frames test no longer records `golden.eval.ok.json` as the one
  golden that disagrees with the engine: 4.1.33 ships it with the bare value,
  so the file now goes through the same builder comparison as every other
  golden.

## 10.11.0

Built on Extension.js 4.1.32.

- The release workflow renders `docs/tools.json` and `docs/clients.json`
  right after it bumps the package version and commits them with the
  release: both files carry the version and the suite asserts the files on
  disk are the current rendering, so the first 10.11.0 run failed its own
  bump.
- The Safari automation hint names the setting the way the engine does: Safari > Settings > Developer > "Allow remote automation", with the Develop menu item on older Safari.

- `extension_dev` carries the control channel by default: `allowControl` defaults to true, so `extension_storage`, `extension_reload`, `extension_open` and `extension_dom_snapshot` work on a plain dev session and a later "reload it" costs no restart; pass `allowControl: false` for a read-only session. `allowEval` stays off until asked and still implies control. The descriptions, the hints, the docs gates, the README and the shipped rules say control is on unless asked off.
- `extension_wait` now says when it is needed (a session started with `wait: false`, a dev answer whose `ready.status` was not ready, a build-only session); `extension_dev`'s answer and the shipped rules say a ready answer ends the run recipe.
- `extension_docs_search`'s description is the trigger: any WebExtension API, manifest key, permission or browser-difference question is answered from the docs first, memory only when nothing matches.
- `extension_build` hands the reading of the output to `extension_analyze` in its hint, and `extension_create` says the scaffold needs no build to verify and names `extension_dev` as the next step.

- The `extension_logs` hint for a Safari session with no log file, the
  README, the rules and the `/extension debug` command name 4.1.21 as the
  Extension.js floor for Safari log streaming in place of 4.1.28, which no
  engine change backed (that number is the `navigate` verb's canary). The
  engine first streamed Safari background and content lines through the
  bridge in v4.1.20 (#533, the webkit background patch that stops Safari
  from skipping the MV3 worker), and v4.1.21 (#566) gave the dev-injected
  background of a project with no background of its own the same shape,
  so 4.1.21 is the first release where every project streams.
- `extension_build` always answers `outputPath`, the folder it checked the
  manifest in: the engine's reported path when the summary carries one, else
  `dist/<browser>` under the package root. On an engine older than the
  summaries contract the field used to be missing and an agent guessed the
  folder. `zipPath` stays beside it when a zip was asked for.
- `extension_create` answers `scripts`: every package.json script the
  scaffolder wrote that runs the engine, with the command, the browser it
  targets and the folder it writes (`npm run build` is flagless, so chromium
  into `dist/chromium`; `build:chrome` into `dist/chrome`; a monorepo
  script's folder is resolved under the package the engine builds). The
  `defaultsApplied.browser` sentence points at that list instead of
  restating it, and the description says to read the folder from there.
- `extension_project_create` defaults the build command to
  `npm run build -- --browser <browser>`, the browser's name per enabled
  browser, in place of `npm run build`: the platform runs the stored command
  as it is and reads `dist/<browser>` afterwards, and a flagless
  `extension build` writes `dist/chromium`, so a default-created project
  produced an empty artifact. `<browser>` in a command of your own is
  replaced the same way `outputDirectory` already did. The description and
  the `buildCommand` input say what the platform does with the command.
- The rules, the `/extension build` command and the `extension_build`,
  `extension_create` and `extension_project_create` descriptions now say
  what the engine does: `extension build` with no `--browser` targets
  chromium and writes `dist/chromium/`, so a scaffolded `npm run build`
  lands there, while `--browser=chrome` and `extension_build` (chrome by
  default) write `dist/chrome/`. The build rule tells the agent to read the
  folder from the build's answer (`outputPath`) instead of assuming
  `dist/chrome/`, which an agent did on 2026-10-08 and got `ls: exit 1`.
- The README and the `extension_create` description now say that a
  successful scaffold sends one `draft_seeded` event to PostHog, what it
  carries, and that `EXTENSION_DEV_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` turns
  it off. Nothing about what is sent changed; a test fails if either text
  stops naming the event or the two variables.
- The Live Preview carrier copy that `extension_dev {carrier: true}` places
  no longer admits `http://localhost/*` or `http://127.0.0.1/*` in its
  `externally_connectable`: on a stranger's machine those ports belong to
  whatever runs there. `EXTENSION_DEV_CARRIER_LOOPBACK=1` on the server
  keeps them for the extension.dev apps' own dev servers; the `carrier`
  description names the permissions the carrier holds and the switch.
- `extension_inspect` no longer sleeps 1.5 s after navigating or 0.5 s when
  it did not navigate: the CDP navigate already waits for the page's load
  event, so both waits read nothing.
- A CDP event listener that throws is reported on stderr with the event
  name instead of being discarded with unparseable frames, and the
  recorded console is kept.
- `extension_list_extensions` connects once to the port the ready contract
  stamped instead of retrying three times 800 ms apart: the port is read
  from a live session's contract, so a refused connection is the answer.
- One JSON frame reader (`src/lib/frame-json.ts`) replaces the two private
  copies in `extension_open` and `extension_eval`.

- The server starts with the local group alone: the 23 of its 32 tools that
  work on this machine. The 9 platform tools (account, share, release and
  store) come on with `--features=local,platform` or
  `EXTENSION_DEV_FEATURES=local,platform` while the platform is in private
  alpha. The Connect recipes name both groups for the two reaches that need
  the platform. The README moves signing in, sharing and the store lane
  under one Platform heading.
- `scripts/live-lane.mjs` drives the real server and the real pinned engine
  per browser, headless, through create, build, dev, wait, logs, list,
  open, dom snapshot, eval, storage, reload, assert and stop, and writes a
  verdict table. On 2026-10-07 it passed on Chrome, Edge, Firefox, Brave,
  Opera, Vivaldi, Yandex, Waterfox, Zen and Floorp. LibreWolf refuses to
  launch until its overrides file turns remote debugging on, so it is no
  longer listed as a dev browser (the `browser` enum still accepts it).
- The build test fixtures feed the engine's own `--output json` envelope on
  stdout and its narration on stderr instead of prose the engine never
  prints; the Safari webdriver seed names the 4.1.32 writer it copies; the
  Gecko assert cells run the real list-tabs reader on the engine's tab
  rows; `extension_reload` has its own test.
- The package lints with the console's rules: eslint-config-auditor's
  recommended and typescript presets, the house style plugin (blank lines
  between statements, curly, banner-aware header rules, no JSDoc prose),
  consistent type imports and the migration warnings, with the React and
  Tailwind layers left out. Every source file was reformatted by the fixer;
  no behavior changed.
- `extension_reload` of the background waits, bounded, for the engine's
  `ready.json` to stamp the executor detached and attached again, and
  reports `reattachedMs`, `detachedAt` and `attachedTs`; when the new
  background has not connected within the budget it answers `reloading`
  with a warning instead of `reloaded`. Before this the engine answered
  `reloading` 50 ms before the old background died, and a read landing in
  the detach-to-reattach gap (measured 11 to 129 ms on Zen and Floorp) got
  "the control channel did not answer". `extension_assert` names that gap
  when its Gecko read lands in it. Zen and Floorp pass the live lane 5 of 5.
- `@modelcontextprotocol/sdk` moves to 1.32.1, past GHSA-6qxp-vccf-f47h
  (the OAuth client paths it fixes are not used here). Its stdio reader now
  refuses a single client message over 10 MiB.
- Housekeeping: the July comment inventory left the repository, local
  audit folders and the package's own `.mcp.json` are ignored, and the
  template sync workflow commits with a plain sentence. The published
  tarball was checked file by file: only `dist`, `bin`, `claude`,
  `extensions`, the plugin manifests, `server.json` and the three top-level
  documents ship. The Extension.js pins already match npm's latest 4.1.32.
- Measured on this machine without a window: `extension_build` for Safari
  validates the manifest, generates the Xcode project and builds the app
  (31 s, bundle id derived from the app name). A Safari dev session and
  its surface reads still need Allow Remote Automation on and the
  extension enabled in Safari > Settings > Extensions, which are attended
  steps, so the live lane does not run Safari on its own.
- Measured on Extension.js 4.1.32: a Firefox MV3 event page answers
  `extension_eval` in `background` like an MV2 page does. The CSP refusal
  rewrite applies to a declared content_security_policy, never to MV3 as
  such.
- The envelope contract copied under the tests is the one Extension.js
  4.1.32 ships (it had stayed at the 4.0.17 bytes, so the byte comparison
  against the installed engine only warned), and the comparison now fails
  on any engine at or above the pinned release instead of only on an exact
  match. A new cell checks the build and doctor fixture builders key for
  key against the engine's golden frames.
- Test-only exports left the public surface: `reviewDist` (callers use
  `reviewDistReport`), `loginProjectRef`, `resolvedEngineVersion`
  (`resolvedEngineFacts` carries the version), the
  `HOLD_STILL_WORKS_SENTENCE` alias and the carrier registry's
  `rememberedCarriers`. A test-audit pass also removed cells that restated
  constants, pinned source spellings, or passed for a reason other than
  the one in their title, and fed the remaining hand-written frames from
  the engine's builders.
- No comments remain in the package beyond the file banner and tool-read
  directives. Every former invariant block is carried by a name, a cell
  title, or a `*-rules.test.ts` cell that fails when the rule is broken;
  each fixture builder names the engine or platform writer it copies, and
  a cell checks the engine markers against the installed engine. The 40
  browser, engine-internal and platform-server facts no code or cell can
  hold left the repository for the maintainers' notes.
- The invariant comments are cut to their rule: 509 blocks become 386 and
  3,744 lines become 2,814, with every ledger citation, date, commit, run
  id, first name and machine reference gone, the 120 that only restated a
  tested rule deleted, and five that no longer matched the code corrected
  (the build is an rslib bundle, the engine stamps the profile path, the
  Safari bundle id pattern is the engine's).
- The six inline `<workspace>/<project>` checks on login, project create
  and the create list now go through `isProjectRef`, so a ref with a space
  is refused where it enters instead of by the platform one call later. The
  login list keeps its own check because its exact-slug rule two lines down
  owns the message.
- Dead code out: `isManagedCarrier`, `credentialProjectRef`, `mirrorActionsUrlFromRunUrl`,
  `browserExitStamp`, `hasSourceMaps`, `REGISTRY_BASE_DEFAULT`,
  `SAFARI_MCP_ADD_COMMAND`, `BrowserType`, `ASSERT_RETIRED_IDS`, two unused
  `vi` imports and the live lane's unused `GECKO` set.
- The lint migration warnings no longer re-enable core `no-unused-vars`
  after typescript-eslint turned it off; `@typescript-eslint/no-unused-vars`
  stays. The same line left the monorepo's shared config.
- Nine test files write `ready.json` through the engine contract builder
  instead of by hand; the stop-hints cells name the dead server pid they
  cut in.
- Sleeps go through `node:timers/promises`; one JSON object reader serves
  login config and the approval gate; `consoleBase` and `consoleProjectUrl`
  moved to `src/lib/console-urls.ts`, which ends the login-flow, registry,
  registry-access import cycle; four shadowed names renamed; the
  platform-hold header read lost a catch nothing could reach.
- Five exports that existed only for tests are gone: `getSession`,
  `resetEngineVersionCache`, `resetSessionIdentityForTests`,
  `resetBatchCreateSessions` and `uninstallCarrierExitCleanup`. The cells
  that used them now read the in-memory registry through `listSessions`,
  or start a fresh module graph per cell, which is what "a new process"
  meant in those cells all along.
- The eval envelope has fixture builders in both shapes, and the golden
  frame cell now compares nine of the engine's twelve golden files key for
  key and names the three without a counterpart. The detect sentences are
  a pure function, so the not-found cell no longer runs a 20 s scan; the
  tool description rules are five tables instead of 160 cells.
- The manifest is trimmed: the 20 `pnpm.overrides` floors from the
  September advisory sweep are gone (the tree resolves past every one of
  them now, and the audit reads the same with or without them),
  `browser-extension-manifest-fields`, `vite`, `@eslint/js` and
  `typescript-eslint` leave the dependencies (nothing imported them), and
  the `clean`, `watch`, `start`, `build` and npm hook scripts leave
  (nothing called them; the release lane publishes with scripts ignored).
- Thirteen test cells that hand-wrote the CLI eval or target-not-found
  envelope now feed the fixture builders; one cell pinned `E_NO_SESSION`,
  a code the engine never sends, and now asserts the engine's
  `E_SESSION_NOT_FOUND`. The engine's own `golden.eval.ok.json` wraps the
  value as `{ result, context }` while its executor and CLI answer the bare
  value; the eval builder follows the engine and a cell names the
  disagreement until upstream settles it.
- The Live Preview carrier leaves the package: the bundled extension under
  `extensions/`, the `carrier` input on `extension_dev` and the loopback
  switch are gone. The carrier only ever reached a machine through this
  package, and with the platform in private alpha there is no public
  delivery for it, so the public package no longer ships a companion that
  holds `<all_urls>`, cookies, history, bookmarks and scripting. A copy an
  earlier server placed is still taken back on `extension_stop`,
  `extension_start` and `extension_build`, and a build that packs one is
  still refused.

## 10.10.13

Built on Extension.js 4.1.32. It closes the last findings of the 2026-10-05 audits.

- Safari dev sessions: Extension.js 4.1.32 opens a `safaridriver` session
  and records it in `ready.json`, which is what this server's Safari page
  reads were built on. When the engine could not open one, the hint and
  `extension_doctor` now relay the engine's own reason (Allow Remote
  Automation off, `safaridriver --enable` not run) instead of saying no
  release opens a session.
- The engine pins move to 4.1.32. Its Vue pin is now 3.5.43, so installs no
  longer carry the `@vue/server-renderer` advisory.
- Windows: a session-state folder that is a file, or sits under one, is
  reported as unreadable instead of as "no sessions", for both session
  markers and Live Preview carriers.
- The test suite runs on Windows on every push.

## 10.10.12

- `extension_stop` on Windows reads the Windows process table to find what
  is left of a session, so a stop that ended the whole tree says
  `stopped` instead of "survivors were not verified". Before this, every
  Windows stop answered `stopped: false`, and `extension_dev` with
  `replace: true` refused every time. A stop still says unverified when
  the table cannot be read. Measured on a Windows runner.
- The lockfile raises `proxy-addr`, `source-map-js` and Vue past their
  open advisories.

## 10.10.11

The rest of the 2026-10-05 audit findings, apart from the Safari WebDriver
fields that wait on the engine.

- `extension_eval` says where it ran and what came back: the tab's url and
  title on Firefox, a note when the value was not serializable, only real
  background targets as the background, and `eval-lost` or
  `eval-unsupported` when the answer never arrived. A woken worker is no
  longer said to have idled when it may never have started.
- `extension_logs` and `extension_assert` report a cut stream: a follow
  that closed early is a partial read, dropped-line markers are not
  counted as events, and console-errors-empty is inconclusive when lines
  were dropped. An unknown console `context` is refused as a bad request
  instead of failing the whole call.
- `extension_wait` and `extension_start` report only what they observed:
  a start session is `build-ready`, a build contract or a stopped session
  is `no-session`, and start refuses Safari and preview-path hosts it
  cannot serve.
- `extension_open` names the DevTools panel frame that appeared, and says
  when the panel registry could not be read or the target was inferred.
- Platform answers of the wrong shape (channels, build index, shares,
  login config) are unreadable, never empty, and an unpinned publish
  matches the build the platform named.
- `extension_stop` counts a process as reaped only once it is gone, and
  ends a Windows session through `taskkill /T /F`. A session marker that
  could not be written is a warning on the started answer, and the
  `release promote` command exits non-zero on an answer it cannot read.
- `extension_list_extensions` on Firefox marks a lone temporary add-on as
  an inferred match.
- The scheduled test tier builds through the real pinned engine with
  `--output json` and checks the fixtures against what it writes.

## 10.10.10

Every sentence the server says is now backed by something it read
.

- Success is read, never assumed. Promote, submit, publish, project and
  workspace create, logout and uninstall read the platform's or the
  library's own answer and say `promoted-partially`, `submit-unconfirmed`,
  `publish-unconfirmed`, `create-unconfirmed`, `not-installed` and the like
  when it falls short. A failed read is reported as unreadable, never as an
  empty list, across eval, open, the tab polls, session markers and
  carriers.
- One resolver returns the token and the project it belongs to. An
  unnamed call sends `EXTENSION_DEV_TOKEN` and takes its project from the
  token's own claims, never from whichever stored login is active; a named
  project sends its stored login first, the private registry grant
  included.
- `extension_manifest_validate` judges each browser through the engine's
  own prefix filter, checks every requested browser's references, refuses
  an unknown target, and blocks only where the engine or the browser
  refuses (a `service_worker` the engine rewrites for Firefox is a
  warning).
- `extension_build` reads `zip_artifacts`, refuses a stale dist, reports a
  timeout as `build-timeout`, uses the engine's own bundle-id rule, and
  writes `firefox-based` builds where the engine does (`dist/gecko-based`).
- `extension_inspect` names the document it read after navigating, counts
  uncaught exceptions as console errors, reports a section that threw as
  `failedSections` instead of an empty value, and marks every cap.
- `extension_open` checks popup, options and sidebar against the manifest
  before asking the engine, says when an open could not be confirmed, and
  never counts a tab it rendered itself as the window.
- `extension_storage` reads a set back; `context` is gone, since the engine
  runs every storage call in the background.
- `extension_assert` counts only the extension's own log lines, reads the
  guest's id from the contract, compares storage values structurally, and
  does not credit a background the dev build injected.
- `extension_stop` with `all` leaves sessions owned by another running
  server alone unless `includeOtherServers` is true; stop and auth are
  marked destructive.
- `extension_dev` reports the control channel from `ready.json`, and a boot
  error that is not a compile error answers `boot-failed`.
- The tool reference `claude/rules/mcp-tools.md` is generated from the
  schemas, and a test validates every example call in the docs against
  them.
- Requires Node 22.12 or later, the floor of the engine this package runs
  in-process.
- The release workflow publishes to npm before it pushes the version
  commit and tag, so a failed publish no longer strands a tag.

## 10.10.9

- One approval now covers several projects in one workspace
 . Onboarding ten projects used to cost
  twenty visits to extension.dev/device, one to create each project and
  one to sign in to it, and the ten tokens then expired together and cost
  ten more. This release is the client half and waits on the platform
  deploy that accepts a list. The platform advertises the capability as
  `batchOnboarding` in its login config; against a platform that does
  not, both inputs below refuse the list before a device code is spent
  and name the one-project call to use instead.
- `extension_project_create` takes `projects`, a list of
  `{ project, repo }` entries in one workspace, in place of `project` and
  `repo`. The approval page lists every name. Each project is created by
  its own request and its 7-day token is stored as that project's login,
  so no `extension_auth` call follows. An entry may carry its own
  `displayName`, `description`, `installCommand`, `buildCommand`,
  `outputDirectory`, `browsers` and `outputDirectories`; the same inputs
  at the top level are the default for entries that leave them out.
- The answer has one row per project: created and logged in, created
  with no token (the hint names the batch login to run), refused with the
  platform's own code, unconfirmed when a request got no answer, or not
  attempted. A refusal about one project (a name taken, a reserved slug)
  does not stop the list. A refusal about the approval (an expired grant,
  the hourly limit, the plan's project limit, a missing GitHub App
  installation) stops it, and every project not reached still gets a row
  saying so.
- A list takes a few calls: creating a project is slow, so while
  projects remain the answer is `status: "creating"` with the same
  `deviceCode` to call again. The provisioning grant is held in the
  server's memory for its 15 minutes and is never written to disk or
  returned; if the server restarts mid-list the projects already created
  stay created and the rest need a new approval.
- One approval creates at most 10 projects, because the platform creates
  at most 10 per hour for one approving account; the next 10 can start
  in a new call once that limit allows. The cap is read from the
  platform's login config (`createProjectsPerApproval`), with 10 as the
  fallback when the platform states no usable number. A longer create
  list is refused before any approval is asked for, with that reason; it
  is never split silently.
- `extension_auth` with `action: "login"` takes `projects`, a list of up
  to 20 `<workspace>/<project>` names of existing projects in one
  workspace (the platform's `loginProjectsPerApproval`), in place of
  `project`. One approval stores one token per
  project, which is also how a set of logins that expire together is
  renewed. One missing project refuses the whole list and stores
  nothing. The call that completes a batch login can take up to a
  minute.
- Both lists are checked before a device code is spent, by the
  platform's own rules: one workspace, 1 to 20 names, no name twice, and
  each project by its exact slug (lowercase letters and digits joined by
  single dashes, at most 48 characters). The refusal names the entry.
- A batch login or create does not change which login is the default.
  A single login still does.
- A server started with `--project` refuses a list that names any other
  project, the same refusal a single call gets, and takes a list of the
  pinned project alone. A list on `logout` or `status` is refused rather
  than ignored.
- `extension_project_create` no longer lists `project` and `repo` as
  required in its schema, since a list replaces them. A call with
  neither form is still refused, by the tool.
- `extension_publish` with `project` now describes the project it was
  called for. The token was already picked
  by `project`, but `registryUrl`, and the build index behind a missing
  `buildSha`, `version` or `builtAt`, came from the most recent login, so
  with several logins stored a publish for one project could return
  another project's registry address and fill its build details from
  another project's builds. The same slip is fixed in
  `extension_release_promote` (the builds page, the channel list and the
  public URLs it returns) and in the `extension_submit` dry run (the
  console page it names). `extension_shares` and `extension_preview_web`
  were checked and did not have it.
- A private project's registry data is read with the login stored for
  that project. It used to be asked with the most recent login, which
  gave up on a mismatch and reported the builds as missing.
- `extension_release_status` reads a `project` given as
  `<workspace>/<project>`, the form every other tool takes. It used to
  join the pair to the active login's workspace and ask the registry for
  an address that names no project, which is also what a server started
  with `--project` sent on every call.

## 10.10.8

- On Firefox, `extension_eval` now reads an extension whose content
  security policy forbids eval, which is every MV3 extension page
 . Extension.js 4.1.31 evaluates such a
  document over the debugger protocol, but the wrapper this server put
  around a popup, options, sidebar or override-page expression called
  eval itself, so those contexts still answered "blocked by CSP" on an
  engine that could read them. A refused surface is now asked again with
  the bare expression, which the engine takes over the protocol and
  awaits there. A project pinned below 4.1.31 keeps the refusal, and its
  hint now names that floor.
- `extension_eval` with `context: "page"` and a `moz-extension://` url
  reaches a page the manifest declares as no surface (`pages/*`), through
  the console actor of the tab showing it. It used to answer
  `E_NO_SURFACE_DOCUMENT`. Open the page with `extension_open` first; a
  page no tab shows answers `E_NO_MATCHING_TARGET`.
- `extension_dom_snapshot` on a `moz-extension://` url reads the page the
  same way when Firefox refuses the injection with "Missing host
  permission for the tab", and returns the engine's own snapshot fields.
- `extension_eval` with `context: "page"` on a site whose policy forbids
  eval now works on an MV3 Firefox build, over the debugger protocol,
  when `url` names the tab. An MV2 build keeps its `tabs.executeScript`
  route, which had gone dead on Extension.js 4.1.31 because that engine
  renamed the refusal to `E_CSP_BLOCKS_EVAL`; both spellings are read now.
- The protocol takes one expression. A statement list sent to a
  policy-locked Firefox document answers `E_BAD_REQUEST` with the way to
  wrap it, where the background used to answer a control-channel error
  carrying "SyntaxError: expected expression".
- Still refused, by name: a string evaluated in the content-script world
  of an extension whose policy forbids eval. Use `context: "page"` or
  `extension_dom_snapshot` there.

- `extension_submit` and `extension_release_status` (include: ["stores"]) link to the console's
  Submissions tab at `/<workspace>/<project>/submissions`, where the page
  moved; the old `/stores` address still redirects. `@extension.dev/urls`
  moves to `^0.8.2`, which carries the new paths.

## 10.10.7

- A share revoke now waits for a person by default, like a real store
  submission and a promotion to stable: the first `extension_shares`
  revoke answers `approval-required` with a link, and the same call with
  the returned `approvalId` runs it once. A revoke cannot be undone, so
  it is the one outward call that should never run on an agent's word
  alone. `EXTENSION_DEV_APPROVAL_GATE=0` still turns the gate off.
- New tool `extension_docs_search`: keyword search over the Extension.js
  and extension.dev docs, returning up to 8 pages with a title, URL and
  an excerpt of at most 400 characters. It calls
  `/api/docs/search` on extension.dev, which ranks with no model call, so
  it is free, needs no login and is in the `local` group. Its
  description is kept short on purpose so it costs little context.

## 10.10.6

- Tools that read a page or an extension (`extension_logs`,
  `extension_dom_snapshot`, `extension_inspect`, `extension_eval`,
  `extension_storage`, `extension_open`, `extension_assert`,
  `extension_reload`, `extension_wait`, `extension_doctor`,
  `extension_list_extensions`) now fence what it wrote between
  `<untrusted-data-ID>` and `</untrusted-data-ID>`, with a fresh random
  `ID` per call named in `untrusted.boundary`, so text on an inspected
  page that says to publish or revoke reads as data, not as an
  instruction. The fence covers `value`, `error`, `warnings` and `hint`,
  because page text also reaches error messages and hints. A tag the
  page writes, even one that guesses the ID, is escaped in the raw text
  and parses back to the same characters, so every answer is still one
  JSON envelope with the same fields. Build, analyze and dev output stay
  unfenced: they carry the project's own source.

## 10.10.5

- `extension_build` and `extension_analyze` report store review risks
  read off the built package, as `value.reviewRisks` plus one warning
  each with the fix: access to every website, code the package did not
  ship (`eval`, `new Function`, scripts or imports loaded from a URL), a
  Firefox manifest without `data_collection_permissions`, and API
  permissions no shipped script uses. They never block a build. On a
  dev build only the manifest checks run, because the hot-reload runtime
  and the injected `management` permission are not what a store
  receives (measured on seven published extensions' dev builds against a
  production build of an official template).

- The bundled `/extension-publish` command now takes an extension through
  store review with this server's own tools instead of sending people to
  the store consoles by hand: it validates, builds, checks for review
  risks, rehearses with `extension_submit` (dry run), and submits only on
  the user's yes through the approval link. It covers Chrome, Firefox,
  Edge and Safari, and keeps whatever manifest version the project
  declares rather than migrating it during a submission.

## 10.10.4

- `--project <workspace>/<project>` (env `EXTENSION_DEV_PROJECT`) pins a
  server to one project. Every unnamed credential read takes that
  project's login instead of the most recent one, an agent signed in to
  several projects can no longer act on the wrong one, and a call that
  names a different project is refused with `status: "project-pinned"`.
  A pinned project with no stored login falls back to
  `EXTENSION_DEV_TOKEN`, so CI keeps working.
- New `@extension.dev/mcp/clients` export: `CLIENTS` and
  `buildRecipe({ client, reach, strictApproval, project })` build the
  exact setup for Claude Code, Cursor, VS Code, Codex and any
  `mcpServers` client. The README's Setup section is generated from it
  (`pnpm readme:clients`, checked by a spec), and the extension.dev
  console's Connect dialog renders the same recipes, so the instructions
  cannot drift. It never emits a setting that turns approvals off.

## 10.10.3

- The engine pin moves off the canary to Extension.js `4.1.31` stable:
  `extension_dev`, `extension_start` and `extension_build` spawn that
  release when a project has no engine of its own, and the nightly
  engine-pin check reads it against `latest` again.

- A human now approves a real store submission and a promotion to stable
  before either runs, by default. The first call answers
  `approval-required` with an `approvalUrl` on extension.dev
  (`/device/approve/<id>`) and an `approvalId`; once a workspace member
  approves (an owner, for a submission), the same call with that
  `approvalId` runs exactly that action, once. Promotions to other channels
  and share revokes stay ungated unless `EXTENSION_DEV_APPROVAL_GATE=1`;
  `EXTENSION_DEV_APPROVAL_GATE=0` turns the default off. Whatever the
  setting, a platform that answers `APPROVAL_REQUIRED` now gets the same
  approval flow instead of a bare failure.

- Two server flags narrow what an agent can reach. `--features=local`
  or `--features=platform` (env `EXTENSION_DEV_FEATURES`) lists one tool
  group; `local` alone is about 40% smaller. `--no-ship` (env
  `EXTENSION_DEV_NO_SHIP`) hides `extension_publish` and
  `extension_release_promote` and refuses a real submit, a share link and
  a share revoke, while dry runs and listing keep working. A refused call
  answers the new code `E_TOOL_DISABLED` with the flag to change. Both
  default to everything on, so no existing setup changes.
- Every tool now carries MCP annotations (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`) from one policy
  table, so clients can auto-approve reads and ask before the rest. A
  merged tool takes its worst action: `extension_shares` is destructive
  because revoke is.
- A device-flow step waiting on a human (`extension_auth` login,
  `extension_project_create`, `extension_workspace_create`) now answers
  `ok: true` with `status: "authorization-pending"` and no error, instead
  of `ok: false` with `E_AUTH_PENDING`, so clients stop rendering the
  first login step as a failure. The approval link and code stay in
  `hint` and `value`; `E_AUTH_PENDING` is retired.

## 10.10.2

- The engine pin moves to the Extension.js canary
  `4.1.31-canary.1791055414.4bbb683a`: `extension_dev`,
  `extension_start` and `extension_build` spawn that build when a project
  has no engine of its own, and the nightly engine-pin check now reads a
  canary pin against the canary dist-tag instead of latest. The canary's
  log query treats level `off` as none (it was a synonym for all), which
  changes nothing for `extension_logs`, whose `off` stays "signals only".
  The canary also adopts a project root only when it owns the manifest
  (same folder, the `src/manifest.json` layout, a dependency on
  Extension.js, or an `extension.config.*` beside it) and otherwise builds
  into the manifest's own folder; the session artifact resolver here
  applies the same four tests, so `extension_wait` and `extension_logs`
  keep reading the ready.json the engine writes.
- Logins to several projects now live side by side in `auth.json`, one
  entry per workspace/project with the latest marked active, instead of
  one slot the next login overwrote. `extension_publish`,
  `extension_release_promote`, `extension_submit`, `extension_shares` and
  `extension_preview_web` take `project` ('<workspace>/<project>', or a
  project slug that matches one login) to pick a stored login, which
  outranks `EXTENSION_DEV_TOKEN`; omitted, the order stays environment
  first, then the active login. `extension_auth` status lists every login
  under `logins`, and logout with `project` removes just that one. A
  version 1 file is read as a store of one and rewritten on the next login
 .
- Four findings from the six-browser sweep: `extension_open` reads new headless off the `User-Agent` field
  of `/json/version` as well (`--headless=new` keeps `Chrome/151` in the
  `Browser` field) and, whatever the launch flags said, falls back to the
  tab route on any window refusal: Chromium's gesture refusal for a popup,
  an options or popup window the engine called opened but no document
  appeared for within 3 s, and Gecko's "Popup is disabled"; a Gecko
  browser that gets Chromium's gesture sentence is answered with
  Gecko wording; and when the background refuses the `runtime.getURL` eval
  the tab route needs (an extension CSP that forbids eval), the
  `moz-extension://` base is read off the profile's
  `extensions.webextensions.uuids` pref through the add-on id the built
  manifest declares, so the fallback still lands (40). `extension_eval` context `background` wakes an idle
  MV3 worker through `ServiceWorker.startWorker` from a page session
  before evaluating, with a warning that it was idle, instead of answering
  `E_NO_TARGET` (41). `extension_open surface: "devtools"` takes `waitMs`
  and `reload` (reload the inspected tab once DevTools is open, for
  extensions that create their panel when the page reports to them) and
  the missing-panel hint names both (42). A page eval the PAGE's CSP
  refuses on a Gecko MV2 build is re-run through `tabs.executeScript`, the
  same wrapper the no-scripting-API case uses (43); an MV3 Gecko build
  keeps the policy explanation, pending.
- `extension_eval` over CDP awaits a promise-valued expression again. The
  CDP routes added for the background and url reads passed `replMode` on every
  `Runtime.evaluate`, and Chrome 151 answers a replMode evaluate with the
  promise object itself, ignoring `awaitPromise`, so `Promise.resolve(42)`,
  an async IIFE or `chrome.tabs.query({}).then(...)` read as `{}` with
  `ok: true` on pages and workers alike. The evaluate now runs without
  replMode, and only an expression Chrome refuses for a top-level `await`
  is re-run in replMode with the promise settled through
  `Runtime.awaitPromise`.
- `extension_open` takes `surface: "devtools"` on Chromium: it opens the
  browser's real DevTools on a tab (the one `url` matches, else the first
  web page) through CDP `Target.openDevTools`, waits for the extension's
  `devtools_page` to register its panel, shows it (`panel` picks a title
  when there are several) and hands back the panel document's url, which
  `extension_eval` reads with context `page` and that url, with
  `chrome.devtools` available. Context `devtools` on `extension_eval` now
  evaluates over CDP on an MV3 session like the other surfaces, and an
  extension document lookup matches the iframe targets a DevTools panel
  and its devtools page are. Works headed or headless (measured Chrome
  151). Gecko gets a refusal that says no protocol opens its developer
  tools.
- `zen` and `floorp` join the browser enum of `extension_dev`,
  `extension_start` and friends, the Gecko family, `extension_browsers`
  detection (app bundles, Linux and Windows paths) and the process match
  `extension_stop` uses, the same way waterfox is listed; the engine has
  launched both since 4.1.26.
- The dependency floors move past every advisory `pnpm audit` reported on
  2026-09-30 (42: 18 high, 22 moderate, 2 low, all transitive): axios,
  brace-expansion, fast-uri, js-yaml, nanoid, devalue, hono, ip-address,
  qs and postcss-selector-parser through `pnpm.overrides`, vitest to 4.1.11
  as a dev dependency. The audit reads zero; nothing the server does
  changes.
- The bundled template catalog moves to the corpus at `2c3a486a`, which
  renamed the `new-*` examples to `newtab-*` and added the `devtools-*`
  family and `sidebar-monorepo-nx`. `extension_add_feature`'s newtab row
  now names `newtab`, `newtab-react`, `newtab-vue`, `newtab-svelte` and
  `newtab-preact`; the catalog-sync PR had failed on the old names every
  day since 2026-09-26.

Nine findings from a session that brought ten third-party extensions under
the server in one day:

- `extension_dev` and `extension_start` spawn the engine in the project
  directory, not where the MCP client started the server, so the engine a
  session drives is the project's own and the started envelope names it
  under `value.engine`.
- Every session artifact path (ready.json, logs, the build summary) now
  resolves from the engine's project root, the nearest package.json,
  deno.json or deno.jsonc at or above the manifest, so a project whose
  manifest sits in a subfolder no longer makes `extension_wait` watch a
  contract the engine never writes.
- A failed `extension_build` carries the compiler errors the engine stamped
  on its contract under `value.errors`, or the bundler's own output under
  `value.output`, and its hint no longer asserts a manifest location the
  engine does not require.
- `extension_wait` on an `extension_start` session answers `launched` at
  once with the production-build guidance instead of spending its budget on
  a "transient" `E_NOT_ATTACHED` that is permanent there; a clamped budget
  is reported in `warnings` on every exit; and a dead-contract note names
  only the browser the call asked about.
- `extension_eval` names the extension's own content security policy when
  the engine refuses with "call to eval() blocked by CSP", instead of
  blaming the expression, and on MV2 Gecko a page or content
  eval goes through `tabs.executeScript` from the background when the
  engine has no scripting API, with the content-world caveat stated
 .
- `extension_open` with a `url` opens a new tab unless `tab` names one, so
  a page under test is never taken over; a path with no scheme resolves
  against the extension's own origin on Chromium and Gecko.
- `extension_manifest_validate` reads `public/` when resolving manifest
  references, warns rather than blocks on a missing web-accessible resource
  and on a Chromium-only side panel, counts `devtools_page` and options
  pages when ranking similar templates and ranks by surface overlap ratio,
  and on Firefox warns on a missing `browser_specific_settings.gecko.id`,
  on Chromium-only keys and on `extension_ids`, and gives an MV2 manifest
  the keys to port for MV3.
- `extension_start` takes `outputPath`, an existing unpacked extension
  directory to launch as it is through the engine's preview verb, so an
  artifact another toolchain produced, or the exact release candidate, can
  be run and watched without an Extension.js build. A directory
  with no manifest.json is refused before anything launches.
- `extension_manifest_validate` warns on Firefox when
  `browser_specific_settings.gecko.data_collection_permissions` is missing,
  which AMO now requires for new add-ons, and shows the minimal form.

Seven more from the same session's functional sweep:

- `extension_eval` reaches the Chromium background over CDP: the MV3 service
  worker or MV2 background page is a target of its own, and evaluating on it
  is the inspector path the extension's content security policy does not
  govern, so state only the worker knows is readable again under
  `script-src 'self'`. An idle worker with no target answers `E_NO_TARGET`
  with how to wake it.
- `extension_eval` with context `page` and a url evaluates on the matching
  tab's CDP target, so a site that enforces Trusted Types (YouTube, Gmail)
  no longer refuses the string; the active-tab refusal names Trusted Types
  and the url route. Every CDP route falls back to the in-bundle
  relay when the session has no debug port.
- `extension_open` asks the browser whether it is headless (HeadlessChrome
  names itself) and renders popup, options and sidebar as a tab at once
  when it is, instead of opening a popup that is gone before the next call
 . A page the browser swapped for its own error page answers
  `navigate-blocked` with the browser's title instead of `navigated`, and
  eval refuses such a tab.
- `extension_browsers` reports the newest managed version when several sit
  in the cache, the one the engine launches.
- `extension_inspect` probes on Gecko return the same shape as on Chromium,
  `{selector, count, samples[]}` with a text snippet per element
 .
- `extension_assert` on Gecko reads `background-worker-booted` off the
  control channel (the bridge executor runs in the background) and
  `surface-rendered` off the surface relay, instead of answering
  inconclusive for want of a CDP target list; a selector clause stays
  inconclusive there and names the tool that probes it.

- `@extension.dev/urls` moves to `^0.8.1`, which reserves `chromium`,
  `firefox`, `mcp` and `skill` as mint slugs.
- `extension_browsers` install hands the canary's installer the server's
  own managed-binary search as `locateInstalledBinary`, which that
  installer now requires to verify an install before it reports success.
- The stored login reader no longer types a missing entry as `undefined`
  where it promises `null`, so consumers that compile the server's source
  under `noUncheckedIndexedAccess` typecheck it.

## 10.10.1

Five Gecko findings from one agent session on Firefox and Waterfox
, each replayed against a live Firefox
Nightly before and after the fix where the shape allowed it, plus four more
that followed them the same week, and the engine release that carries the
root-cause fix for the first of them.

- `extension-create`, `extension-develop` and `extension-install` move from
  4.1.29 to 4.1.30. That engine settles a promise before a surface relay
  replies to an eval (the root cause behind the first entry below, filed
  from this repo as extension.js 512), names a missing tab, a refused url,
  a closed surface and a browser exit on every act verb instead of a
  generic refusal, and lets `reload` resolve a surface's tab. The relay
  wrapper below stays: a project that pins an older engine in its own
  node_modules still drives that engine.

- `extension_eval` on a surface that answers through the in-bundle relay
  (every Gecko session, and Chromium MV2) never hands the relay a promise.
  The relay evaluates synchronously and passes the raw value to
  `sendResponse`; a promise is not cloneable, Firefox reports that to the
  sender as no reply, and the bridge then called the surface "not open"
  while the page was still running the expression. The wrapper now settles
  a thenable inside the page under a token, and the tool polls until it is
  done: an async expression returns its value, a rejection answers `E_EVAL`
  with the page's own message, and one that never settles answers
  `E_WAIT_TIMEOUT` naming where the result will land. The engine's "open it
  first: extension open newtab" hint is now spoken as the tool call it means.
- `extension_inspect` on Gecko reads a page inside the extension through
  its surface relay: a url that matches a declared surface document (the
  full `moz-extension://` address, the document path, or its file name)
  routes to that context instead of the tab injection, which Firefox
  refuses into extension pages with "Missing host permission for the tab".
  An extension url that matches no declared surface says so and names the
  ones the manifest declares.
- `extension_stop` reaps the browser the launcher recorded in `ready.json`
  (`browserPid`, `launcherPid`, and any process holding `profilePath`), so
  a Firefox started on a custom profile, or one whose argv never names the
  project, no longer survives a `stopped` answer with `reaped: []`.
- `extension_doctor` no longer calls a Gecko session unhealthy over a
  browser exit that the executor outlived: Firefox hands a fresh profile to
  a relaunched process and the first one exits 0, which the engine's browser
  leg reports as a failure while storage probes and evals keep answering.
  That leg becomes a warning that says so, and any other failure still
  counts.
- `extension_browsers` detect finds a managed binary as deep as the cache
  writes it (a Firefox Nightly sits six levels down inside its app bundle),
  so it no longer reports the system Firefox as available while
  `extension_dev` launches the cached Nightly. When both exist, the entry
  carries `systemBinaryPath` and a `devLaunches` line saying which one dev
  starts and how to choose the other. `extension_wait` reports `browserPid`
  and `profilePath` from the contract.
- `extension_open` with surface `sidebar` on Gecko no longer stops at the
  engine's "sidePanel not available", a Chromium API named on a Firefox
  engine. It asks the sidebar relay whether the `sidebar_action` panel is
  open and reports `status: "already-open"` when it is (Firefox opens the
  panel at install, so it usually is); when it is not, the document is
  rendered as a tab with the gesture rule stated (Firefox opens the panel
  only from the toolbar button or View > Sidebar, Bugzilla 1392624).
- `extension_eval` with context `page` and a `moz-extension://` url on
  Gecko evaluates through the surface relay of the document that url names,
  with a warning naming the context to pass next time, instead of "chrome.
  scripting is not available ... use context background". An extension url
  that matches no declared surface says which surfaces the manifest
  declares. The url-to-surface mapping now lives in one place for inspect
  and eval.
- `extension_dev` with `port: 0` no longer warns "Requested port 0 was not
  available": 0 asks the engine for any free port, so the note now says
  which port it picked, and the collision wording stays for a numbered port
  the server could not bind.

## 10.10.0

Safari was the one engine this server treated as a dead end, while the
Extension.js it shells out to had grown a working Safari dev loop. The client
now rides that loop, and its pinned CLI packages move to the release that
has it.

- `extension-create`, `extension-develop` and `extension-install` move from
  4.1.2 to 4.1.29, the stable release that carries the `navigate` verb
  (first shipped in a 4.1.28 canary). On Safari that engine reloads the extension
  on every save through the extension's own bridge, streams background and
  content lines into the session's log file, and points a tab at a url
  without eval; a project with no local Extension.js now gets all of that
  from the pin.
- The bridge tools work on a Safari dev session started with
  `allowControl` or `allowEval`: `extension_storage`, `extension_reload`,
  `extension_open` for surfaces, `extension_dom_snapshot` by tab id,
  `extension_logs`, and the assertions `content-script-injected`,
  `background-worker-booted`, `storage-key-present` and
  `console-errors-empty`, measured live on Safari 27. `extension_eval` in
  `content` or `page` needs a tab already open at the url, and Safari's MV3
  background CSP blocks eval in `background` and the bridge's `url`
  navigation, which the engine reports by name. `surface-rendered` and
  `extension_inspect` still need a target list Safari does not expose, and
  say so.
- `extension_browsers` reports Safari's version and an `automation` block
  (the safaridriver beside it and whether it speaks `--mcp` and `--bidi`),
  and `extension_doctor` with no `projectPath` gains a `safari-agent` leg,
  so an agent learns when Apple's Safari MCP server can pair with this one.
  The packaged CLAUDE.md and `/extension-debug` describe that pairing.
- `extension_open` with `url` asks the engine's `navigate` verb first, a
  static tabs call inside the extension that works where an MV3 background
  refuses eval, which is every Safari session. Only an engine that does not
  know the verb yet falls back to the background eval, and that fallback
  names the upgrade when Safari's CSP refuses it.
- If a dev session records a safaridriver session in `ready.json`
  (`webdriverPort`, `webdriverSessionId`), `extension_eval` with context
  `page` and `extension_open` with `url` use it for the page's main world,
  and `extension_doctor` adds a `safari-window` leg; with no such record
  the leg is a skip and both tools take the bridge.

Four defects agents met while driving the server on real extension work
 close in the same release.

- The initialize result now carries `instructions`: four lines that name
  the moments (run, wait, inspect, drive, build an extension) and the tools
  that own them, for clients that hide tool descriptions behind a search
  step and would otherwise show the model only a server name and a tool
  count. `createServer()` is exported so a client can initialize against
  the same server object the stdio path connects.
- `extension_open` with surface `newtab`, `history` or `bookmarks` resolves
  the `chrome_url_overrides` page itself and opens it by url. The engine's
  `open` verb never knew those surfaces and answered `E_ARGS` "unknown
  surface" to exactly what the tool description promised; an override page
  is only ever a tab, so this is the surface, not a fallback, and the hint
  says so.
- `extension_open` with surface `sidebar` on Chromium, when Chrome refuses
  `sidePanel.open()` for lack of a user gesture, opens the extension's own
  sidebar page in a tab, dispatches a synthetic click on it over CDP, calls
  `chrome.sidePanel.open` from inside that click and closes the tab. The
  panel that opens is the real one; the result reports `gesture:
  "synthetic-click"` and a warning that the toolbar wiring was not
  exercised. If the click does not open it either, the sidebar document is
  rendered as a tab with the reason in a warning, and if even that fails
  the refusal gains a hint naming the url to read instead of ending the
  road. Headless sessions keep their tab fallback and never click.
- `extension_eval` on a Chromium MV3 session evaluates extension pages over
  CDP: contexts `popup`, `options`, `sidebar`, `newtab`, `history` and
  `bookmarks`, and context `page` with a `chrome-extension://` url. The
  inspector path is not governed by the extension page CSP that blocks the
  in-bundle relay's string eval, and script injection could never reach an
  extension page at all, which is where the misleading "Extension manifest
  must request permission to access this host" came from. A page that is
  not open answers `E_NO_TARGET` with the `extension_open` call that opens
  it; a thrown expression answers `E_EVAL` with the exception text; a bare
  top-level `await` parses, as in the DevTools console; MV2 Chromium and
  Gecko sessions keep the relay. Both this path and the sidebar gesture were
  measured live on Chrome for Testing 151 before release.

## 10.9.0

The client ran its browser work through CLI packages pinned three minor
releases back, so an agent driving the MCP got 4.0.30's behavior while the
same person running `extension` on their own machine got 4.1.2's. Every fix
shipped in between reached the terminal and stopped at the MCP.

- `extension-create`, `extension-develop` and `extension-install` move from
  4.0.30 to 4.1.2. The browser, logging and install paths the MCP tools call
  into now behave the way the documented CLI does.
- No tool surface changes: the same tools take the same inputs and answer the
  same shapes.

## 10.8.0

Some MCP actions change what a public channel serves or hand something to a
store, and none of those can be taken back in place. The client now carries
an approval gate for exactly those actions, so a human can stand between an
agent's proposal and the write when the platform asks for one.

- `extension_submit`, `extension_release_promote` and the destructive
  `extension_shares` actions accept an `approvalId`. When the platform's
  approval gate is on, the first call answers `approval-required` with an
  approval id and a URL a human approves at extension.dev; the same call
  repeated with that id performs the action. Rejections and pending
  approvals answer as themselves, never as a bare error.
- Approvals are bound to an action fingerprint, so an approval for one
  promote cannot be replayed on another.
- The gate is off unless the platform enables it; every existing flow is
  unchanged by default.

## 10.7.0

The published client had no idea the platform could be held, so on the five
lanes that run on our machines a reader met either a bare status code or an
honest refusal that then sent them to a page answering 503. That is what
makes someone conclude the product is broken.

- A held lane now answers one shape on `extension_publish`,
  `extension_release_promote`, `extension_submit`,
  `extension_project_create`, `extension_shares`, `extension_preview_web`
  and the registry reads behind `extension_release_status`: status
  `platform-held`, `error.platformCode` set to `PLATFORM_NOT_OPEN`, and a
  message carrying the condition, what still works, and a way back.
- What still works is the part that was missing. Creating, developing and
  packaging an extension run on your own machine, they are free forever, and
  the hold does not touch them, so `extension_create`, `extension_dev`,
  `extension_build`, `extension_manifest_validate` and `extension_doctor`
  are named in the refusal and repeated in `value.stillWorks`.
- A held refusal may not point at a held surface, so the only link it
  carries is `templates.extension.dev`, the one surface that stays open,
  and no refusal names a date.
- Registry reads no longer collapse a non-ok response to
  `<url> returned <status>`. The body is read once and its message travels
  with the result, so a refusal the platform wrote reaches the reader
  instead of a number. A held read is answered without buying an access
  grant first, because a shut lane is not an auth problem.
- The hold is recognised by the `code` field and the `x-extensiondev-hold`
  header rather than by matching the sentence, so the wording can change on
  the server without a client release.

## 10.6.1

Two reply strings pointed a stranger at surfaces the public hold keeps
dark, so the remedy they named was a dead end wearing an instruction.

- The closed-lane refusal in `extension_project_create` now relays the
  server's own message verbatim whenever the server sends one, so the
  platform decides what a caller reads there. The hardcoded console
  pointer survives only as the fallback for a refusal that carries no
  message field.
- `extension_release_status` no longer promises that publicUrl links
  need no login today. They are the public build pages and open without
  login once the project is publicly reachable, and the console Builds
  page is described as the authoritative record rather than a view the
  caller is promised to see render.

## 10.6.0

The server covered every stage of the lifecycle except the one an agent
needs most. It could read anything, so every expectation had to be
hand-rolled as a string of JavaScript over a blob, which is the guessing
the paired skill exists to prevent.

- `extension_assert` is the test stage: a list of expectations in, one
  verdict each out. Five checks ship, `background-worker-booted`,
  `surface-rendered`, `content-script-injected`, `storage-key-present`
  and `console-errors-empty`, and the run is a pass only when every one
  of them passed.
- A check that the platform cannot cover comes back `inconclusive`, never
  a pass and never a red against the extension, and carries a `settledBy`
  naming the evidence that would answer it. A content script's execution
  is not observable from outside its isolated world, so a declared
  `content_scripts` match is inconclusive rather than a pass; an absent
  MV3 worker target is inconclusive because Chrome delists an idle one;
  zero errors over a session that never wrote a log line is inconclusive
  because zero errors and zero events are the same number; a read the
  platform refuses, such as `chrome.storage` without `allowControl`, is
  inconclusive because nothing was learned about the extension.
- The verdict document is a port of the preview lane's own contract, with
  its own contract name and check registry so the two can never be
  confused, and each check names the preview check it is the
  live-browser counterpart of. A contract test pins the outcome
  vocabulary, the check and document shapes, and the aggregation rule
  against that package's own code whenever a monorepo checkout is
  reachable, the way the STORE.md corpus pins its parser.
- The manifest candidate list, which `extension_open` held three copies
  of, moves to one reader that every caller shares.

## 10.5.0

`extension_submit`'s STORE.md advisory and the platform parser that feeds
AMO and Partner Center disagreed, and the disagreement ran in the
dangerous direction: the advisory stayed silent about notes the
submission would never carry.

- The hand-rolled section and field probing in `extension_submit` is
  replaced by `src/lib/store-md.ts`, an exact port of the parser the
  submission runs. Headings the platform ignores, such as
  `### AMO reviewer notes` or a Firefox-naming Edge section, now raise
  the warning they always should have.
- A contract corpus of 14 STORE.md fixtures and a pin generated from the
  platform parser hold the two implementations together: the pin carries
  the upstream file's sha256 and its answer for every fixture, and the
  suite replays both parsers over the corpus whenever the upstream
  checkout is reachable. Neither side can move alone.
- When the notes are found, the advisory now names the file it read and
  says the submission reads STORE.md from the source repository at the
  built commit, so an uncommitted edit is never mistaken for a
  submission that carries it.

## 10.4.3

Four truths an agent reads got sharper. A share recorded twice is one
share, a feature map that points at source without the feature is a lie,
and a stale corpus snapshot makes both worse.

- `extension_shares` dedupes `localOnly` by artifactId and counts distinct
  shares in its hint; the append-only record file is untouched and
  `localRecord` reports entries beside shares so both readings stay
  available.
- `add_feature` stops pointing options and devtools at a template that
  carries neither surface, returning the full plan with an honest note
  instead of a wrong reference; the vue, svelte and preact sidebar rows
  point at their real in-framework files. A guard test now validates
  every mapping against the bundled snapshot.
- The offline template snapshot moves from the July 16 corpus to the
  current nightly: 52 templates, the renamed sidebar-monorepo-turborepo,
  sane surface data.
- `@extension.dev/urls` moves from 0.3.0 to the published 0.6.0, ending
  the last published-versus-checkout divergence the provenance guard
  tracked.

## 10.4.2

The engine moved twice in a day and the agent lane has to move with it.
`extension-develop` 4.0.30 carries the MAIN-world public path fix: a
content script running in the page's own world now resolves extension
assets through the isolated-world bridge base instead of falling back to
the host page, where it 404'd.

- `extension-create`, `extension-develop` and `extension-install` move
  from 4.0.29 to 4.0.30. The nightly `engine-pin` job added in 10.4.1 is
  what would have caught this drift; the bump is the first it prompted.

## 10.4.1

The engine this server spawns had drifted nine releases behind the one a
human gets from `npx extension@latest`. Agents were building on 4.0.20
while the published CLI was 4.0.29, so every engine fix in that range was
missing from the agent lane, including both theme-colour conversions
shipped this week: a `theme.colors` project a human built green still
failed when an agent built it. Nothing in this repository changed when
the engine shipped, which is why it went unnoticed until a walk of the
MCP journey read `extension_doctor` closely.

- `extension-create`, `extension-develop` and `extension-install` move
  from 4.0.20 to 4.0.29, so the agent lane spawns the engine npm serves.
- A nightly `engine-pin` job now reads npm rather than the working tree
  and fails when a pin trails the published engine, when a pin is a range
  or a dist tag, or when it is missing. It sits beside the existing
  registry-listing watch, because the event that invalidates both happens
  in another repository.

## 10.4.0

Every place a tool named a template, it pointed the caller at GitHub and
never at the catalog that serves the same template with screenshots,
metadata and a deploy button. The MCP was routing around its own front
door. Template emissions now carry the catalog detail URL alongside the
existing fields, and the offline fallback corpus moved to the commit the
catalog actually serves.

- `extension_templates` list results gain `catalogUrl`,
  `https://templates.extension.dev/<slug>?utm_source=mcp&utm_medium=tool`,
  beside `repositoryUrl` and `downloads`, which are unchanged. The source
  view and `extension_add_feature`'s reference template carry the same
  field.
- `extension_create` results gain `templateCatalogUrl` for the template
  the project was scaffolded from, with `utm_source=mcp-create` so
  create-path visits stay distinguishable from browse-path visits.
- The pinned fallback template corpus moved to `52c0d871c433`, the commit
  the live `latest` channel pointer resolves to, so the offline corpus and
  the catalog agree.

## 10.3.1

The 10.3.0 tarball shipped two comments a stranger could read: an HTML
comment in the popup markup naming a private package, and an eight line
internal roadmap comment plus two inline script comments in the live
preview sandbox page. Both were removed at source right after that
release. This release exists to take them off the registry, because a
published tarball cannot be edited in place.

- The popup markup no longer names any private package.
- `extensions/live-preview/chromium/sandbox/page-0.html` ships exactly
  the markup it runs, with no comments at all.

## 10.3.0

Four fixes for places where a tool answered confidently about something it
had not actually checked: a login refusal that never said where the slugs
come from, a doctor report labelled with a browser that had no session, a
preview probe that certified whatever was listening on the port, and a
release gate that passed on a stale bundle.

- `extension_auth login` refused a malformed `project` without saying
  where the two slugs come from. Both the refusal and the input schema now
  name the console address bar as the source: an existing project's page is
  `console.extension.dev/<workspace>/<project>`, and a project that does
  not exist yet is created at extension.dev/new first.
- `extension_doctor` diagnoses the session that exists, not a hardcoded
  default. The shared session resolver only counts contracts marked
  "ready", which is exactly wrong for the tool you reach for when a session
  failed: doctor fell back to chrome, labelled the report with it, read the
  absent contract, and returned a healthy verdict over a session that had
  errored. When there is no ready session, the browser with a contract on
  disk wins, newest first and whatever its status.
- `extension_preview_web` certifies the probe against the build the call
  just minted instead of against the port. Anything can be listening on the
  local preview port, and the old probe read `hostReachable` and
  `previewLoadable` as true off whatever JSON came back, then echoed that
  server's `identifier`, name and version into the envelope unmarked, which
  made any local server a text channel into the agent's context. The name
  and version must now match the `dist` manifest read off disk, and the
  identifier is echoed only when it matches the derivation the real
  middleware uses. A mismatch returns the status
  `host-serving-different-artifact` with `previewLoadable: false`, and
  anything the host claimed that could not be confirmed locally travels
  clipped under `probe.hostReported`, named as the host's claim.
- The release gate asserts the version the built bundle exports rather than
  grepping the bundle for the version string. The grep greenwashed: the
  bundle carries the pinned engine version and fifty-two `"version":"1.0.0"`
  strings from the template corpus, so a release cut at any of those
  numbers passed the gate over a stale `dist`. `dist/module.js` now exports
  the manifest version it inlined at build time, and the gate reads it back
  and compares.

## 10.2.0

A production walk of the full share-and-publish loop, then a fix for every
roughness it surfaced, on top of a week of engine tracking and preview
hardening. Everything landed since 10.1.0 ships here; the 10.1.1 version
bump was never published and is folded in.

- Revoking a share accepts the ids the platform actually mints: `gen_` plus
  64 hex characters, with the older 32-character form still valid. A
  malformed reference is refused by name, with what a real id looks like,
  instead of being silently cut down to a 32-character prefix that revokes
  nothing while reporting the wrong cause.
- Every revoke handle the tools return points at `www.extension.dev`
  directly, so one plain DELETE works. The apex `extension.dev` answers
  DELETE with a redirect, and a caller that does not follow redirects got
  "Redirecting..." back while the share stayed live.
- `extension_doctor` hands over the CLI's own report when the engine exits
  nonzero with output the server cannot parse: the response carries
  `cliReport`, the doctor's actual check list and remediations, instead of
  discarding it and guessing that the local CLI is stale.
- `extension_inspect` with no `url` ranks the extension's own surfaces
  first and the toolchain's pages last, so it no longer inspects the
  Extension.js welcome surface and reports on the wrong document. When only
  toolchain or override pages are open, a warning names exactly which page
  was inspected and how to target yours.
- `extension_publish` against a host where the token's project does not
  exist now says what to do: check the token's scope with `extension_auth`,
  create the project first at extension.dev/new, or log in against a
  project that exists there.
- `extension_auth status` asks the platform who the stored credential
  really is instead of trusting the file on this machine, and reports the
  three answers apart: the server confirmed it, the server refused it and
  the workspace shown is only a local claim, or the server could not be
  reached and nothing here is server confirmed. A credential minted against
  a development deployment reads as refused where production refuses it,
  which is what it always was and never said.
- The MCP `isError` flag now agrees with the envelope: every `ok: false`
  result is marked `isError: true`, so an agent branching on the transport
  flag no longer reads a platform refusal, a publish 404 or an auth 401, as
  success.
- `extension_preview_web` with `share: true` no longer fails a working
  share because the local dev lane is dead: the uploaded link is what was
  asked for, so the result is `ok: true` with status `shared` and a warning
  naming the unreachable local leg, which is expected outside the
  extension.dev monorepo.
- The Extension.js engine pin moved to 4.0.20, the server asks the engine
  its version and JSON support from its published capabilities instead of
  paying for a second build to find out, and a canary pin no longer parses
  to NaN.
- Safari packaging lets an agent name the app and bundle id it is
  packaging, and the docs say what a derived bundle id actually costs a
  developer instead of claiming Apple rejects it.
- Preview and share housekeeping: `hostUrl` is pinned to a local server,
  stale carriers are cleared on start and swept on every exit, re-sharing
  is documented for what it really does, and the CORS verdict is read off
  the last hop a browser would follow.
- The offline template fallback points at the published corpus, three
  control refusals are told apart instead of sharing one message, and a
  stray binary file no longer ships in the package.

## 10.1.0

A six-lens audit of the whole surface (auth, platform, run, see, act and
build, plumbing) followed by a fix pass over everything it confirmed. 33
fixes, the ones you would notice first:

- A failed spawn of the dev CLI (npx missing from PATH) no longer crashes
  the whole MCP server; it fails that one call with guidance.
- `extension_wait` now ignores ready contracts stamped before the current
  session, so a leftover file from a crashed run can no longer report the
  previous session's compile error as yours.
- `extension_create` never deletes a directory it did not create: the
  transient-failure cleanup used to wipe pre-existing directories, including
  their `.git`, when scaffolding into one.
- `extension_submit` dry runs are platform-primary: a platform-reported
  preflight failure can no longer be overwritten by locally computed store
  health, and token-only CI callers no longer fail the dry run for lacking a
  local credentials file. The tool also gained a `projectPath` input so the
  STORE.md advisory check reads the project, not the server's cwd.
- `manifest.json` with `world: "MAIN"` no longer fails Firefox validation:
  Firefox has supported the MAIN world since 128. The rule is now a
  strict_min_version advisory.
- Device login reports hard server errors as errors, on both the tool and
  the CLI paths, instead of authorization-pending or a bogus timeout; the
  login flow now enforces the same cleartext-http refusal as every other
  token-bearing path, validates the returned project scope before storing
  credentials, and the CLI prints the one-click approval link.
- `extension_publish` with a pinned buildSha no longer fills the response
  with a different build's metadata when the pin is not in the local index.
- `extension_shares` no longer labels your own expired shares as "not owned
  by this token" when listing with `status: "live"`, and revocation is only
  reported permanent when the platform confirmed it.
- `extension_logs` accepts the `newtab`, `history`, and `bookmarks`
  contexts, `level: "off"` silences console output instead of returning all
  of it, and a stream error mid-follow returns what was collected instead
  of discarding it.
- `extension_stop` and session bookkeeping survive an MCP restart: session
  markers are cleaned when a session exits on its own, single-project stop
  consults the same on-disk markers as `all: true`, orphan reaping escapes
  regex metachars in project paths and only kills plausible session
  processes, and a replaced session can no longer unregister its successor.
- `extension_open` trusts the live browser over the computed id hash when
  they disagree (symlinked dist paths), so it no longer navigates to a
  nonexistent extension id and no longer reports a successfully opened
  surface as a failure.
- Offline first runs work: the bundled template catalog snapshot is now the
  fallback when the network and cache are both unavailable, a corrupted
  cache file heals instead of erroring, and a shapeless 200 response is no
  longer cached for an hour.
- `extension-mcp --help`, `--version`, and unknown commands now answer
  instead of silently starting a stdio server.
- The release pipeline bumps the version before building, so the published
  bundle reports the version it ships as, with an assertion gating publish
  on it and on the type declarations existing.
- Docs and drop-ins caught up with the code: template count corrected to
  50+, the AI template slugs are `ai-claude` and `ai-chatgpt`, Firefox
  support noted for `extension_list_extensions` and Safari for
  `extension_submit`, and the `extension_dom_snapshot` description names
  which subpaths need the debug port.

## 10.0.0

Every tool now returns the same frame. Before this, 28 tools hand-built 142
different JSON shapes: `ok` appeared on 71 of them, `error` on 67, `hint` on 60,
`message` on 49, `status` on 46, and five more keys carried the same meaning
under different names. An agent could not tell success from failure without
knowing which tool it had called.

The frame is schema 1, the same one the Extension.js CLI emits under
`--output json`:

```json
{
  "schema": 1,
  "ok": false,
  "command": "extension_dev",
  "status": "compile-failed",
  "value": null,
  "error": { "code": "E_FIRST_COMPILE", "message": "…" },
  "hint": "…",
  "warnings": []
}
```

`command` names the tool. `status` is a kebab-case word from that tool's own
vocabulary. `error.code` is stable and worth branching on; `error.message` is
free copy and is not. The payload moved under `value`, and every advisory note
that used to have its own key is now an entry in `warnings`.

**Breaking.** Every payload key moved one level down. `build.success` is now
`ok`, `doctor.healthy` is now `ok`, `manifest_validate.valid` is now
`value.valid`, and `wait` gained the `ok` it never had. The ready contract's own
`command` is carried as `value.sessionCommand`, because the envelope claims that
key. `authorization_pending` became `authorization-pending`, with the old
spelling echoed as `value.legacyStatus` for one minor.

`extension_dev` and `extension_start` also stopped reading the dev server's
prose to decide whether the first compile failed. They poll its `ready.json`
contract instead, which splits a locked profile out of a dead browser and
returns the compile errors as a list. The output scrape survives only as a
fallback for a project whose own CLI predates the contract, is confined to one
`@deprecated` module, and says so in `warnings` whenever it is used. The choice
is a capability probe, never a version check: a project-local `extension` binary
wins over this package's pin, so the version is not knowable in advance. The
contract's own error stamps are read whatever the engine's age, so a locked
profile is named as one the moment the engine records it.

## 9.0.0

Every client pays for this server's tool list at the start of every session,
whether or not the user ever touches an extension. That list was 36 tools and
52,403 bytes on the wire (roughly 13,100 tokens). It is now 28 tools and
43,214 bytes (roughly 10,800 tokens), a 17.5% cut, with no capability removed.
Eleven tools folded into the four that already owned their resource,
`extension_preview` folded into `extension_start`, and the prose was tightened
everywhere it repeated the schema or a parameter name.

9.0.0 lands close behind 8.0.0 on purpose. 8.0.0 renamed four tools for
disambiguation; this release cuts what the surface costs. Both are breaking,
adoption is still low, and doing them as one migration is cheaper for early
users than spacing them out.

### Migration

| Old tool | New call |
| --- | --- |
| `extension_detect_browsers({ browsers })` | `extension_browsers({ action: "detect", browsers })` |
| `extension_list_browsers()` | `extension_browsers({ action: "list" })` |
| `extension_install_browser({ browser })` | `extension_browsers({ action: "install", browser })` |
| `extension_uninstall_browser({ browser, all })` | `extension_browsers({ action: "uninstall", browser, all })` |
| `extension_login({ project, deviceCode, api })` | `extension_auth({ action: "login", project, deviceCode, api })` |
| `extension_whoami()` | `extension_auth({ action: "status" })` |
| `extension_logout()` | `extension_auth({ action: "logout" })` |
| `extension_list_templates({ surface, framework, tags, featured, query })` | `extension_templates({ action: "list", surface, framework, tags, featured, query })` |
| `extension_get_template_source({ slug, files })` | `extension_templates({ action: "source", slug, files })` |
| `extension_release_list({ workspace, project, api })` | `extension_release_status({ include: ["releases"], workspace, project, api })` |
| `extension_store_status({ workspace, project, api })` | `extension_release_status({ include: ["stores"], workspace, project, api })` |
| `extension_preview({ projectPath, browser, port, noBrowser, ...launch })` | `extension_start({ projectPath, build: false, browser, port, noBrowser, ...launch })` |

Every argument keeps its name and its meaning. `action` defaults to the most
common case (`detect`, `status`, `list`), so `extension_browsers({})` scans,
`extension_auth({})` reports the login, and `extension_templates({})` lists.
`extension_release_status` returns both sections by default and nests each
under `releases` and `stores`; the old flat bodies are unchanged inside them.
The CLI is untouched: `extension-mcp login|logout|whoami|release` still work
exactly as before.

`extension_submit`, `extension_publish`, `extension_analyze`,
`extension_inspect` and `extension_dom_snapshot` were deliberately NOT merged.
8.0.0 separated them because agents confused them; folding them behind an
`action` parameter would hide that ambiguity rather than remove it.

### Upgrading from 7.0.0

Most installs are still on 7.0.0 and two majors have landed on top of it. Do
both in one pass: apply the 8.0.0 renames, then the 9.0.0 merges above. 7.0.0
advertised 36 tools; 9.0.0 advertises 28, and every capability survived.

| 7.0.0 call | 9.0.0 call | Landed in |
| --- | --- | --- |
| `extension_deploy(...)` | `extension_submit(...)` | 8.0.0 |
| `extension_inspect({ projectPath })` | `extension_analyze({ projectPath })` | 8.0.0 |
| `extension_source_inspect(...)` | `extension_inspect(...)` | 8.0.0 |
| `extension_dom_inspect(...)` | `extension_dom_snapshot(...)` | 8.0.0 |
| `extension_detect_browsers({ browsers })` | `extension_browsers({ action: "detect", browsers })` | 9.0.0 |
| `extension_list_browsers()` | `extension_browsers({ action: "list" })` | 9.0.0 |
| `extension_install_browser({ browser })` | `extension_browsers({ action: "install", browser })` | 9.0.0 |
| `extension_uninstall_browser({ browser, all })` | `extension_browsers({ action: "uninstall", browser, all })` | 9.0.0 |
| `extension_login({ project, deviceCode, api })` | `extension_auth({ action: "login", project, deviceCode, api })` | 9.0.0 |
| `extension_whoami()` | `extension_auth({ action: "status" })` | 9.0.0 |
| `extension_logout()` | `extension_auth({ action: "logout" })` | 9.0.0 |
| `extension_list_templates({ surface, framework, tags, featured, query })` | `extension_templates({ action: "list", surface, framework, tags, featured, query })` | 9.0.0 |
| `extension_get_template_source({ slug, files })` | `extension_templates({ action: "source", slug, files })` | 9.0.0 |
| `extension_release_list({ workspace, project, api })` | `extension_release_status({ include: ["releases"], workspace, project, api })` | 9.0.0 |
| `extension_store_status({ workspace, project, api })` | `extension_release_status({ include: ["stores"], workspace, project, api })` | 9.0.0 |
| `extension_preview({ projectPath, browser, port, noBrowser, ...launch })` | `extension_start({ projectPath, build: false, browser, port, noBrowser, ...launch })` | 9.0.0 |

Read the `extension_inspect` row before any of the others. That name exists in
both versions and does not mean the same thing in each. In 7.0.0 it read a
BUILT extension's files off disk. In 9.0.0 it reads a RUNNING extension over
the browser's debugger protocol and needs a live `extension_dev` or
`extension_start` session. A 7.0.0 call left alone does not fail with an
unknown-tool error, it silently reaches the wrong tool and reports no dev
session instead of the file sizes you asked for. The disk reader is
`extension_analyze` now. Every call that passed a bare `projectPath` and
expected sizes, permissions and store-readiness back has to move.

`extension_deploy` carried its error names with it into `extension_submit`:
`DeployAuthError`, `DeployInputError`, `DeployConfigError`,
`DeployNetworkError` and `DeployError` are now `SubmitAuthError`,
`SubmitInputError`, `SubmitConfigError`, `SubmitNetworkError` and
`SubmitError`. Anything branching on those strings has to move with them.

Every argument keeps its name and its meaning across both majors, with two
exceptions:

- `extension_release_status` nests what the two 7.0.0 tools returned flat,
  under `releases` and `stores`. The bodies inside are byte-for-byte the old
  ones. Omitting `include` returns both sections.
- `extension_start` gained `build`, defaulting to `true`. `build: false` is
  what `extension_preview` was.

Nothing else moved. `extension_publish`, `extension_preview_web`,
`extension_shares`, `extension_release_promote`, `extension_dev`,
`extension_build`, `extension_create`, `extension_add_feature`,
`extension_wait`, `extension_stop`, `extension_logs`, `extension_eval`,
`extension_storage`, `extension_reload`, `extension_open`,
`extension_list_extensions`, `extension_manifest_validate`,
`extension_theme_verify` and `extension_doctor` are unchanged in name and in
arguments, and the CLI (`extension-mcp login|logout|whoami|release`) never
moved at all.

### Merged

- **Four browser tools are one.** `extension_browsers` detects, lists,
  installs, and uninstalls. `detect` and `list` were the confusable pair: both
  answered "what browsers do I have", and telling them apart took a sentence of
  prose in each description. An action enum settles it in the schema.
- **Three auth tools are one.** `extension_auth` signs in, reports the stored
  login, and clears it. They were a lifecycle triad that each re-explained the
  same token model.
- **Two template tools are one.** `extension_templates` searches the catalog
  and reads a template's source. The slug you read comes from the list you just
  searched, so the pair is one resource.
- **The two read-only release tools are one.** `extension_release_status`
  returns release channels and recent builds, browser-store submissions and
  review state, or both. They took identical arguments and read the same
  registry. `extension_release_promote` stays separate on purpose: it is the
  only verb that writes, and putting a write behind the same `action`
  parameter as a read is how an agent promotes a build it meant to list.
- **`extension_preview` folded into `extension_start`.** Both answered "run the
  production build in a browser"; the only difference was whether a build ran
  first. That is now `build`, defaulting to `true`, which matches
  `extension_preview_web`, where `build: false` already means the same thing.

### Sharpened

- **`extension_dev` and `extension_start` now say which one to pick.**
  They are not merged: `dev` is the only tool that can unlock the control
  channel (`allowControl`, `allowEval`) that `extension_storage`,
  `extension_reload`, `extension_open`, `extension_dom_snapshot` and
  `extension_eval` need, and `start` runs a production build with none of it.
  A `mode` parameter would have made those flags look valid on a session that
  cannot honor them. Instead each description now opens with the thing that
  decides between them and names the other tool.
- **Descriptions no longer repeat the schema.** The biggest cuts, in bytes of
  description: `extension_shares` 1,661 to 1,250, `extension_preview_web`
  1,151 to 639, `extension_submit` 1,478 to 1,194, `extension_eval` 1,128 to
  831, `extension_wait` 985 to 784, `extension_list_extensions` 944 to 696,
  `extension_dom_snapshot` 965 to 854. What was cut was prose that restated a
  parameter name, repeated a property's own description, or explained the
  response shape the response already carries. What was kept is anything that
  stops a tool being misused: the `activeTab` gesture warning on
  `extension_open`, the MV3 service-worker CSP note on `extension_eval`, the
  profile-lock explanation on `extension_dev`, and the irreversibility of
  `extension_submit` and of revoking a share.
- **Repeated property schemas are shared.** `projectPath`, the session
  `browser`, the call `timeout`, the platform `api` base and the launch browser
  enum are defined once in `src/lib/common-schema.ts` instead of being
  re-typed per tool.

### Considered and rejected

- **A smaller default surface with the rest opt-in.** The platform cluster
  (`extension_auth`, `extension_publish`, `extension_submit`,
  `extension_release_status`, `extension_release_promote`, `extension_shares`,
  `extension_preview_web`) is 13 KB, about 30% of what is left, and is dead
  weight for anyone building an extension locally without an extension.dev
  account. Hiding it behind an env flag would cut the default surface by
  roughly a third. It was not shipped because a hidden tool is an invisible
  capability: an agent asked to publish would report that it cannot, which is
  worse than the tokens. The version worth building expands the surface once a
  login exists and announces it with `notifications/tools/list_changed`, and
  that needs a client-by-client compatibility check first.

### Added

- `pnpm exec node scripts/tool-surface-size.mjs` starts the server, calls
  `tools/list`, and reports exactly what a client receives: bytes per tool
  split into description and schema, and the total. `--json` for the raw rows.
  Before this, the cost of the tool surface was never measured, only guessed.

## 8.0.0

Four tools are renamed. Every rename fixes a name that made agents pick the
wrong tool, and one of them could cost you a store submission you did not ask
for. No behavior changes, no argument changes.

### Migration

| Old name | New name |
| --- | --- |
| `extension_deploy` | `extension_submit` |
| `extension_inspect` | `extension_analyze` |
| `extension_source_inspect` | `extension_inspect` |
| `extension_dom_inspect` | `extension_dom_snapshot` |

`extension_publish` is unchanged.

### Renamed

- **`extension_deploy` is now `extension_submit`.** The pair was inverted
  against every other developer tool: `extension_publish` pushes a build to the
  extension.dev platform, while `extension_deploy` submitted to the Chrome Web
  Store, Firefox AMO, Edge Add-ons and the App Store. An agent told to "deploy
  my extension" reached for the store tool, and picking wrong there means an
  unintended store submission, which is irreversible. "Submit" is the stores'
  own word for it ("submit for review"), so the name now says what happens.
  `extension_publish` keeps its name and its job. The error names in the
  response follow: `DeployAuthError`, `DeployInputError`, `DeployConfigError`,
  `DeployNetworkError` and `DeployError` are now `SubmitAuthError`,
  `SubmitInputError`, `SubmitConfigError`, `SubmitNetworkError` and
  `SubmitError`.
- **Three tools were called inspect; now one is.** `extension_inspect` read a
  built extension's files off disk, `extension_source_inspect` read a running
  extension's live state, and `extension_dom_inspect` snapshotted one surface's
  DOM. The name that reads as the primary one belonged to the static file
  reader, which is the least of the three. Static analysis is now
  `extension_analyze`, and the live-state tool takes `extension_inspect`.
- **`extension_dom_inspect` is now `extension_dom_snapshot`.** It is not a
  duplicate of the live-state tool and it survives the rename with its
  capabilities intact, but sharing the word "inspect" was most of why the two
  were confusable. The descriptions now state the split outright:
  `extension_dom_snapshot` is the surface picker (it is the only tool that
  reads an OPEN extension surface by name, the only one that takes a numeric
  `chrome.tabs` id, and the only one that enumerates what is open) and it
  returns a shallow snapshot over the CDP-free agent bridge, which needs
  `allowControl: true`. `extension_inspect` is the deep reader (it is the only
  tool that pierces CLOSED shadow roots, runs CSS selector probes, and
  navigates a tab before reading it) and it rides the debugger protocol.

## 7.0.0

`preview.extension.dev` is the only web door this package knows about. The
inspect door predates it and had stopped being reachable.

### Removed

- **`extension_preview_web` no longer takes `surface` or `inspectUrl`.**
  `surface:"inspect"` pointed a local build at `inspect.extension.dev` over the
  `inspect://path` scheme, which is what the tool did before
  `preview.extension.dev` existed. Only the inspect dev server ever answered it:
  the deployed origin serves store listings and has no `/__inspect/fetch`, so
  the door resolved on one machine and nowhere else. Every build now renders in
  `preview.extension.dev`, which is also the surface that carries the
  Emulated/Real lane toggle and the Trace tab. The response no longer carries a
  `surface` field, and `hostUrl` is the only origin override.
- **The carrier no longer allowlists `inspect.extension.dev`.** Pairing needs a
  page that opens the bridge, and inspect never did: it traces the emulated lane
  of the extension it fetched and has no lane toggle. `extension_dev`
  `carrier: true` and the pairing notes now point at `preview.extension.dev`,
  and the carrier's `externally_connectable` drops the origin that was never
  going to connect.
- **`extension_login` no longer falls back to the GitHub device flow.**
  extension.dev hosts the device flow itself and federates GitHub server-side, so
  the only authorization surface is `extension.dev/device` and no GitHub token
  ever lands on the caller's machine. The legacy path is gone entirely: the
  GitHub device-code client, the `provider` fork (which existed twice, once in the
  tool and once in the `extension-mcp login` bin), the
  `/api/cli/login/exchange` hop, and the `EXTENSION_DEV_GITHUB_CLIENT_ID`
  override. Stored credentials record `provider: "extensiondev"` and
  `extension_whoami` reports that instead of defaulting to `"github"`. Nothing
  changes for a caller who was already on the branded flow, which is every caller
  the platform has served since it went live; a self-hosted platform pinned to
  the old exchange endpoint is no longer supported.

## 6.6.0

A shared build belongs to the project that owns it, not to whoever happened to
press publish. `extension_shares` now says which of the two it is looking at,
and it names the publisher without ever inventing one.

### Added

- **Every listed share carries its owner and its publisher.** The platform now
  returns `owner` and `sharedBy` on each row and both come through untouched,
  alongside an `attribution` block that reads them. `attribution.ownership` is
  `"project"` when the owning workspace holds the share, `"personal"` when one
  person holds it alone, and `"unknown"` when the platform disclosed no owner.
  `attribution.ownerPath` gives the owning `workspace/project` for a project
  share. Ownership is read off `owner` and never off the publisher, because the
  owner is what decides who may revoke a share and the publisher is only who
  made it.
- **`attribution.revocableBy` says who can actually pull the link back.** A
  project share is revocable by any member of the owning workspace and by any
  token scoped to the owning project. A personal share belongs to one person,
  so nobody else can see it or revoke it and a project token cannot touch it.
  Knowing which of the two you are holding is the difference between a revoke
  that will work and a 404 that reads like a bug.
- **`server.ownership` counts the listed shares by owner.** Project, personal
  and unknown, so a list can be reasoned about without walking every row.

### Changed

- **A publisher is never guessed.** `attribution.credit` is the GitHub login
  when the platform resolved one. When a share was made by a CLI token whose
  issuer could not be resolved it reads `CLI token <id>`, which is exactly what
  the credential itself proves, and a share made before attribution existed
  reads as not recorded. The workspace slug, the project slug and the owner are
  never substituted for a name, because naming a team where a human is expected
  attributes the share to whoever the reader takes that team to be.
  `attribution.creditSource` says which of the three it was.
- **Attribution is stated as attribution.** The response spells out that
  `sharedBy` records who published a share and grants and restricts nothing, so
  it is not read as a permission.
- **A truncated list is more explicit about why.** `truncated` also goes true
  when the platform spends its budget working out which shares the caller is
  entitled to see, so the note now says `matched` is a floor rather than a
  total.
- **Revoking a share the token does not own explains the personal case.** The
  404 message already covered a different project and an already dead link; it
  now also names a teammate's personal share, which no project token can
  revoke.

## 6.5.0

A link you shared is no longer only as findable as the response that created
it. The shares you have made are now listable, and revocable, from the tool
that made them.

### Added

- **`extension_shares` lists and revokes the links you have shared.**
  `share:true` hands back a public link, an `expiresAt` and a `revokeUrl`, and
  until now the only copy of that `revokeUrl` was the tool response and the
  project's own `.extension.dev/shared-previews.json`. Neither could say what
  was actually still live, and neither existed at all for a link shared from
  another machine. `action:"list"` (the default) asks the platform for every
  artifact the logged-in project owns and returns each one's `artifactId`,
  name, version, live or dead state, `createdAt`, `expiresAt`, `revokedAt`,
  size, and its `previewUrl`, `zipUrl` and `revokeUrl`. `previewUrl` and
  `zipUrl` come back null for anything no longer live, because a revoked or
  expired address resolves for nobody and echoing it back would invite passing
  on a dead link; `revokeUrl` stays on every row.
- **`action:"revoke"` kills a link from where it was made.** It takes an
  `artifactId` or, just as well, any URL of the share (`previewUrl`, `zipUrl`,
  `viewUrl`, or `revokeUrl`), so the link you sent someone is enough to pull it
  back without going to find a `curl` command. Revocation is permanent: the zip
  is deleted and the id is burned, so a revoked link can never resolve again
  and sharing the same build later mints a different one. The response says so
  rather than reading like an undoable delete.
- **The platform's answer is reconciled with the project's record.** Pass
  `projectPath` and every listed share is matched against
  `.extension.dev/shared-previews.json`: a share the project recorded carries
  its local `sharedAt`, `browser` and `distDir`, a share the platform knows
  about but the project does not is flagged `remoteOnly` (shared from another
  machine or another checkout), and a local record with no artifact behind it
  is reported under `localOnly`. The tool only ever reads that file, never
  rewrites it, so its append-only history stays intact.
- **A cut list is never passed off as the whole set.** When the platform
  answers `truncated:true`, the response carries the count that came back
  against the count that matched, says to raise `limit` or narrow with
  `status:"live"`, and refuses to call a `localOnly` record dead, because a
  share missing from a truncated list has not been shown to be gone.

### Changed

- **A successful share now says where to find the link again.** The `share`
  note and the `extension_preview_web` tool description both point at
  `extension_shares`, at the moment the link exists and the question of how to
  reach it later is about to come up.

## 6.4.0

A build on your machine can now become a link someone else can open, and the
bundled Live Preview carrier finally allows the origin that opens it.

### Added

- **`extension_preview_web` renders an in-progress build in the web emulator.**
  It builds the project, points `preview.extension.dev` at `dist/<browser>` over
  the dev-only `preview://build` scheme, and returns a deep link plus a
  loadability check against the preview dev server. `surface:"inspect"` renders
  in `inspect.extension.dev` instead, for fixture and forensic work. This tool
  reaches npm for the first time in this release.
- **`share:true` uploads the build you just made.** It POSTs the resolved
  `dist/<browser>` to the platform's artifact store and returns a public
  `preview.extension.dev` link that renders those exact bytes, for a recipient
  with no install, no sign-in, and no dev server. That link also serves the
  whole build as a downloadable zip (`share.zipUrl`), so sharing it hands over
  the built code. `share.serves` reports `uploaded-local-build`. Sharing needs a
  token scoped to an existing extension.dev workspace and project
  (`extension_login` or `EXTENSION_DEV_TOKEN`, valid up to 7 days), degrades to
  a login hint when there is no token, and never fails the local preview.
  `share` also returns `expiresAt` and `revokeUrl`: shared builds expire, and
  `DELETE`ing `revokeUrl` with the same token kills the link for good, which is
  the part a TTL alone cannot do when a link reaches the wrong person.
- **A shared link's revoke handle survives losing the tool output.** Revocation
  is permanent and re-sharing mints a new artifact id, so `share.revokeUrl` is
  the only handle that can ever pull a given link, and losing it used to mean
  waiting out the 30-day TTL. Every successful share is now appended to
  `.extension.dev/shared-previews.json` in the project, next to the carrier's
  own project-local state and gitignored the same way: one entry per share with
  `previewUrl`, `artifactId`, `revokeUrl`, `expiresAt`, `zipUrl` and the time it
  was shared. The list is only ever appended to, an unreadable file is kept
  aside instead of overwritten, a write that fails never fails the share, and
  the returned `share.record` and note say where the handle went. If the entry
  cannot be added to `.gitignore`, the response says so.
- **`extension_theme_verify` settles a Chrome theme manifest before it ships.**
  It derives every color current Chrome would paint from the manifest with a
  transcribed Chromium resolver and reports the divergence class of any problem:
  D1 fabrication, D3 parity gap, D4 acceptance gap (keys Chrome silently
  discards, such as dead legacy keys, incognito keys, unknown keys and
  out-of-range values). The legs that need a real browser come back as
  `needsAttended` with a pointer to the attended harnesses, never as passed.

### Fixed

- **The bundled Live Preview carrier reaches `preview.extension.dev`.** This
  package ships the carrier prebuilt and `extension_dev` materializes it into
  the project's `./extensions`, so the carrier only changes when the package
  does. Its `externally_connectable` allowlist had no web preview origin, so a
  page on `preview.extension.dev` could not talk to the carrier at all. 6.3.0
  shipped without the fix.
- The carrier popup requested `icons/icon.png` while the carrier build ships
  `images/icon.png`, so the popup icon was broken.

### Changed

- `extension_preview_web` takes no `channel` argument. It renders the build on
  disk, not a promoted CI build. `extension_publish` and
  `extension_release_promote` are unchanged and remain the path for released,
  channel-scoped builds.
- The server advertises 35 tools, up from 33.

## 6.3.0

Private projects stop reading as empty, and the links this server hands back
stop being login-only.

### Fixed

- **Registry reads work for PRIVATE projects.** `extension_release_list`,
  `extension_store_status`, `extension_deploy` and `extension_publish` read the
  project's state from `registry.extension.land`, which answers 401 for a
  private project. That 401 was reported as "no registry data", so a project the
  operator owns and is logged into looked like it had no builds at all. A 401 or
  403 now mints a short-lived read token and retries once. Public projects are
  untouched: still one request, still no call to the platform.
- The stored login token is never used as the `?t=` URL parameter even though it
  would verify. It is long-lived, and a credential in a query string is kept by
  every proxy and access log on the path, so it is traded for a ten-minute token
  first. Requires the bearer path on `POST /api/access-grant`.

### Added

- **Public build links.** `extension_release_list` returns a `publicUrl` for
  every channel and build plus a `publicProjectUrl`, and
  `extension_release_promote` returns `publicChannelUrl` and `publicBuildUrl`.
  Every link these tools returned before pointed at the console, which requires
  a login and workspace membership, so it was a dead end for the teammate or
  reviewer the operator wanted to send it to. The public pages carry the
  per-browser downloads, the run-locally and integrity dialogs, and what's new.
  For a private project the response says plainly that an outside recipient
  still needs a share link from `extension_publish`.
- `api` is accepted by `extension_release_list` and `extension_store_status`,
  matching the other hosted-facing tools. It picks the platform the read token
  is minted against and the origin the returned links point at.

### Changed

- Depends on `@extension.dev/urls` `^0.3.0` for the new `userland` origin and
  its whole-URL builders, so a build link this server returns cannot drift from
  the routes the viewer serves.

## 6.2.0

The URL layer stops being a copy. This server used to carry byte-identical
vendored mirrors of the fleet's origin resolver and path builders, kept honest
by a drift guard; it now depends on the published package instead.

### Changed

- **Depends on `@extension.dev/urls` instead of vendoring it.** The mirrors at
  `lib/urls-origins.ts` and `lib/urls-paths.ts` are gone, and `registry.ts`,
  `login-flow.ts`, and `create.ts` import the package directly. It is bundled
  into `dist`, so the install footprint is unchanged: no new runtime
  dependency, same standalone server.
- **`preview.extension.dev` resolves like every other fleet origin.** `preview`
  is now a first-class origin in the shared resolver, so `EXTENSION_DEV_PREVIEW_URL`
  is honored and an unset preview host follows the same local-vs-prod signal as
  console, inspect, and registry rather than defaulting to production.

## 6.1.0

The create flow stops dead-ending at `run dev` and points you to the web to
host, template source resolves whichever path the catalog listed, and the
links the server hands back ride the exact corpus commit it built from.

### Added

- **`extension_create` signposts the web deploy.** The result now carries a
  `deployUrl` and a closing next step that says the scaffold runs locally and
  where to open the template on the web to host it, so the local scaffold no
  longer stops at `run dev` with nowhere to ship.
- **`extension_create` names the template it chose.** When no `template` is
  passed the response now discloses the silent default instead of quietly
  scaffolding TypeScript, and points at `extension_list_templates` to pick
  another.

### Fixed

- **`extension_get_template_source` resolves listed paths.** A file listed
  with a leading `public/<slug>/` or `examples/<slug>/` prefix now strips to
  the slug relative path both hosts actually serve, so passing back a listed
  path no longer 404s.
- **`extension_list_templates` keeps the vanilla template filterable.** The
  relabel no longer drops the framework key the filter reads.
- **`extension_add_feature` links ride the pinned corpus.** Feature links now
  point at the pinned corpus commit instead of floating on `main`.

## 6.0.0

The server moves to Apache-2.0, and the live-preview carrier stops living
in your project, reports what it refused, and rides an engine that tells
you when the browser turned your extension away.

### Changed

- **License: MIT is now Apache-2.0.** Everything published up to and
  including 5.6.1 was released under MIT and stays MIT forever; you keep
  those rights on those versions. From 6.0.0 forward the license is
  Apache-2.0, which adds an express patent grant and requires anyone
  shipping a modified copy to state that they changed the files. For almost
  every user this changes nothing about what you are allowed to do.

### Fixed

- The live-preview carrier is no longer a permanent resident of the
  project. `extension_stop` removes it, `extension_build` removes it
  before the build runs (and refuses to call a build clean if it ever
  finds the carrier in `dist/`), and `extension_dev carrier: true` adds
  it to `.gitignore` so the first `git add -A` cannot vendor it. Every
  path is marker-guarded: a directory the tool did not place is reported,
  never removed.
- `extension_open` no longer navigates away whatever page the caller was
  watching. It reuses only a disposable tab (blank, new-tab page, or a
  tab already on the same extension origin) and otherwise opens a new
  background tab, so a trace page keeps its carrier registration.
- `extension_open` treats a client-side redirect as a landing instead of
  reporting `NavigateFailed`, and reports where the page went. A failed
  `http(s)` navigation no longer sends the caller off to debug their own
  bundle.
- `extension_open` confirms with the browser that a UI surface actually
  opened. When the engine reports the surface opened and no document
  target appears, the result says so (`SurfaceDidNotOpen`) and points at
  `asTab: true`, instead of handing back a green answer for a surface
  that is not there.

- The bundled carrier payload answers with its real results. Every
  backend method returns the promise it was given instead of a shape,
  so a `chrome.*` call that rejects reaches the caller as a failure;
  `executeScript` refuses `func`/`code` forms it cannot honor, offscreen
  close is verified, and `downloads.erase` is implemented. A refusal now
  rides a `refused` disposition from the refusal site through the carrier
  into the trace, so refused calls stop being badged as real work and
  stop earning coverage. Storage rows correlate on a canonical key (one
  call, one row), tab facts survive both directions, and the event port
  replays its backlog to a page that connects late.

### Changed

- The engine this server spawns when a project has no local install is
  pinned to `4.0.16-canary.1784889479.74e12044`. Two behaviors are worth
  the prerelease: `EXTENSION_HEADLESS` is finally honored, so an agent
  driving `extension_dev` cannot open a window on the operator's screen,
  and a browser refusing to load the extension is reported as an error
  instead of a session that claims to be ready. `extension_wait` already
  surfaces both through the ready contract. This pin returns to a stable
  release once 4.0.16 ships. A project with its own `extension` install
  is unaffected, and `EXTENSION_MCP_CLI_VERSION` still overrides.
- `extension_deploy` and `extension_store_status` advertise `safari`
  again: the platform's Safari/App Store submission lane is now enabled
  for every project, so the store enum and the per-store status report
  treat it like chrome, firefox, and edge.
- `extension_list_templates` and `extension_get_template_source` resolve
  the template catalog and sources from the pinned, content-addressed
  corpus served at `media.extension.land`, with a commit-pinned GitHub
  raw fallback. Both tools previously read a floating `nightly`/`main`
  ref, so two runs could disagree; they now resolve one immutable
  release whose files are sha256-verified at the origin.
- Console and dashboard links come from a shared URL contract and are
  environment aware, so a local or development run no longer hands back
  hardcoded production console URLs.

### Added

- `extension_dev` accepts `carrier: true` (Chromium-family sessions): it
  places the bundled Extension.dev Live Preview carrier in the project's
  `./extensions` folder, which Extension.js auto-loads as a companion
  beside the extension under development. Pages the carrier allowlists
  (inspect.extension.dev, localhost) can then pair with the live session
  and stream its real-lane chrome.* session trace over the carrier's
  event port. The copy is marker-guarded: an existing unmanaged
  `extensions/extension-dev-live-preview` directory is never overwritten,
  and the tool result reports what happened either way. The prebuilt
  payload ships in the package under `extensions/live-preview`.

## 5.6.1

### Changed

- `extension_deploy` and `extension_store_status` no longer advertise
  `safari` as a store. The Safari/App Store submission lane does not
  exist yet (the platform now also rejects such submissions server-side
  with `SAFARI_LANE_DISABLED`), so the tool schemas stop inviting agents
  to try it. Safari as a build/run target is unchanged.

## 5.6.0

Firefox reaches full protocol parity: every formerly Chromium-only
feature now works on Gecko, over RDP or the agent bridge.

### Added

- `extension_list_extensions` works on Firefox-family sessions. It rides
  the Remote Debugging Protocol root actor's `listAddons` over the
  `rdpPort` the engine stamps into ready.json from extension.js 4.0.15
  on. Entries list INSTALLED add-ons regardless of
  live contexts, `temporarilyInstalled` marks temporary loads, and the
  dev session's extension is flagged `ownExtension` by matching the
  ready contract's identity (with a lone temporary install as the
  fallback signal). Add-on targets are never attached to or evaluated
  in; system and hidden add-ons are filtered out. Older engines get a
  hint naming the 4.0.15 requirement instead of a generic failure. A
  minimal RDP client (`src/lib/rdp.ts`) carries the handshake; legacy
  RDP was chosen over WebDriver BiDi on purpose, since BiDi is
  single-session and would block attaching alongside other consumers.
- `extension_dom_inspect` listTargets works on Firefox: RDP tab
  descriptors as `{actor,url,title,type}`, with the same two-id-space
  warning as the CDP path (an actor id is not a chrome.tabs id).
  Discovery therefore needs no allowControl on Gecko, unlike listTabs.
- `extension_source_inspect` closes its four Gecko gaps. dom_snapshot
  and extension_roots ride the bridge eval, embedding the same CDP page
  scripts Chromium uses (the bridge html path also gained the
  shadow-aware serializer, so open extension-root shadow content is in
  the markup now). console rides the RDP watcher's cached-resource
  replay (`getWatcher` with server target switching, then
  watchResources; verified live that `getCachedMessages` is a dead end
  on current Firefox), summarized in the same shape as the CDP console
  buffer. deepDom walks CLOSED shadow roots through
  `tabs.executeScript`, where Firefox exposes
  `Element.openOrClosedShadowRoot` to content scripts, so it needs an
  MV2 session with host permissions for the target url; a failed walk
  reports why in `notes` instead of silently dropping the field.
- MV2 page-eval fallback: the engine's page-context eval needs
  chrome.scripting, an MV3-only API, so Firefox MV2 sessions reported
  every bridge inspection as Unsupported. The inspect expression now
  falls back to compiling in the tab's content-script sandbox via
  `tabs.executeScript`, which reads the identical DOM; callers see the
  same result shape on both paths.

### Fixed

- Act-verb CLI output over ~8KB no longer truncates. The engine CLI
  exits without draining stdout, and the socketpair pipe Node hands a
  child buffers about 8KB, so any larger `--output json` frame (a DOM
  snapshot, a big html capture) arrived cut mid-JSON and surfaced as
  "CliError: extension exited with code 0". The MCP now hands the child
  file descriptors and reads them after exit, which no pipe buffer can
  truncate. The workaround stays until the engine flushes before exiting.

### Known limitation

- Firefox MV3 sessions cannot use the bridge extras: the MV3 event page
  CSP blocks the eval the control bridge dispatches through the
  background, exactly like Chromium MV3 service workers. MV2 sessions
  are fully covered via the executeScript fallback. The RDP paths
  (list_extensions, listTargets, console) work on both manifest
  versions.

## 5.5.2

Honest browser support wording ahead of the Safari lane landing.

### Changed

- The package description and README now say Safari is coming next
  instead of listing it alongside the browsers that are store-ready
  today. Chrome, Edge, Firefox, and every Chromium- or Gecko-based
  browser remain fully supported; nothing changes functionally.

## 5.5.1

The store journey stops being write-only after submit, and the token
surfaces start telling the truth about lifetimes and API bases.

### Added

- `extension_store_status` (tool 33): the post-submit sibling of
  `extension_deploy`. Reads the project's public registry
  (`stores/health.json`, `stores/status.json`, `stores/submissions.json`)
  and reports per store whether it is configured, its latest credential
  health check, the last recorded submission (version, status, store
  URL, submitted-at), and the latest review status. Normalizes both the
  v3 merged status schema and legacy v2 poller documents. Defaults to
  the logged-in project; accepts `workspace` + `project` overrides like
  `extension_release_list`. A configured store with a failing credential
  reports `configured: true` with `health.ok: false` (rotate the
  credential, deep-linked), never "not configured".

### Fixed

- `extension_whoami` no longer asserts a bare `api` field that could
  misstate the platform base (a login minted via a localhost dev server
  kept reporting that dead base for a token that authenticates against
  production). The recorded login base is now labeled
  `apiRecordedAtLogin`, `apiDefault` reports what authenticated tools
  actually target, the message flags any divergence, and a set
  `EXTENSION_DEV_TOKEN` is disclosed as outranking the stored login.
- The 7-day token TTL (server-enforced) is now stated everywhere a CI
  author looks: `extension_login`'s description and success/pending
  results, `extension_whoami`'s `tokenTtlNote` (with the deep console
  Access tokens URL), and the auth prose of `extension_deploy` and
  `extension_release_promote` (`extension_publish`'s auth envelope is
  byte-frozen and unchanged).
- `extension_deploy`'s description says the per-store rows in the result
  are the verdict to trust: the platform's bare preflight line does not
  check store health. A real (non-dry-run) submission now points at
  `extension_store_status` for tracking.

## 5.5.0

The debug surfaces learn to point at things: tabs are targetable by
URL, extensions in lists have names, and eval works on the default
template by default.

### Added

- `extension_dom_inspect` targets tabs by `tabUrl` (case-insensitive
  URL substring, title as fallback). Exactly one match inspects it and
  the result names the resolved target; zero or multiple matches return
  the candidate targets instead of guessing. `listTargets: true` lists
  the browser's live CDP page targets (targetId, url, title, type) with
  the standing warning that a CDP targetId is NOT a chrome.tabs id.
- `extension_list_extensions` names its entries. The dev session's own
  extension resolves to `name`, `version`, and `ownExtension: true`
  (identified by recomputing Chrome's unpacked-extension id from the
  ready contract's distPath) and sorts first; entries that cannot be
  resolved carry a note saying why instead of a silent bare id. Other
  extensions' contexts are never attached to or evaluated in.

### Fixed

- `extension_eval` works on the default template by default. On
  Chromium with an MV3 manifest the default context is now `page` (the
  MV3 service worker CSP blocks background eval), disclosed in the
  result as `defaultedContext` with the reason; explicit
  `context: "background"` is unchanged and keeps its CSP explanation.
  Firefox and MV2 defaults are untouched. A defaulted eval that lands
  on an unreachable active tab returns a hint to navigate or pass
  `url`/`tab`.
- Error remedies speak tool arguments, never CLI flags: the engine's
  `--context page --tab <id>` prose is rewritten into `context:`/
  `tab:`/`url:` vocabulary, with guards so ordinary prose is never
  garbled by the rewriting.
- The debugging documentation's headline example now runs on the
  default template (page-context eval); the background variant is
  labeled MV2/Firefox, and the cross-browser matrix states per-context
  eval support honestly with the MV3 CSP footnote.

## 5.4.0

The DevX swarm's non-blocker friction clusters, cleared: waiting is
narrated, ports tell the truth, artifacts say where they are, and error
prose explains the extension instead of the engine.

### Added

- `extension_wait` narrates its budget. `timeoutMs` is a documented
  argument (default 45000, clamped 1000 to 50000; the legacy `timeout`
  spelling stays as a deprecated alias), every result carries `budgetMs`
  and `elapsedMs`, and a timeout says what WAS observed plus a
  call-again hint instead of an opaque failure. The status splits
  `compiled` from `browserAttached`, and a `noBrowser` build-only
  session returns immediately with `buildOnly: true` and a plain
  statement that no browser will ever attach.
- `extension_build` with `zip: true` returns `zipPath`, the absolute
  path of the file the engine actually wrote (its name sanitizer strips
  punctuation, so the filename rarely matches the project name), and
  `zipSourcePath` for `zipSource: true`. When a zip cannot be located
  after a successful build the result says so in `zipPathNote` instead
  of omitting the field silently.

### Fixed

- `extension_dev` reports the actually-bound port. The engine's
  ready.json carries the bound port from its first stamp, so dev reads
  it after the health window and re-registers the session with the true
  port; when the stamp has not landed yet, dev claims no port at all
  and says `extension_wait` reports the bound one. dev and wait now
  share one source of truth and cannot disagree about the same session.
- `extension_build` warns when it writes over a live dev session's
  dist: the dev browser may serve the production artifact until the
  next recompile. The build is never blocked; the clobber is named.
- `extension_inspect` classifies `.zip` files as archives and excludes
  them from `shippableSize` and the 10MB store gate (the package is not
  payload), with an `archiveNote` explaining the exclusion.
- `extension_whoami` anchors its identity to the stored token that
  `extension_login` minted: it does not follow the current working
  directory, and the wording now says so.
- `extension_open` explains a popup-less extension instead of relaying
  the engine error: a manifest pre-check reports that nothing sets
  `action.default_popup`, lists the surfaces the manifest DOES declare,
  and points at the right next verb. Headless popup errors state the
  exact headed path (`extension_dev` with `replace: true` and
  `EXTENSION_HEADLESS=0`).
- `extension_dev`'s `earlyOutput` drops V8 asm.js verdict lines (pure
  noise); real errors are preserved.

## 5.3.1

### Added

- `extension_login` pending results lead with the one-click device link
  when the flow provides one (RFC 8628 `verification_uri_complete`): the
  user opens it and approves with the code pre-filled, no typing. The
  bare URI and code stay in the result as the fallback for flows that
  cannot prefill.
- `extension_deploy` and `extension_release_promote` accept each other's
  spelling for the same build commit: deploy folds a `buildId` argument
  onto its canonical `buildSha`, and promote folds `buildSha` onto its
  canonical `buildId`. Full-schema validation errors enumerate the new
  aliases alongside the rest of the contract.

### Fixed

- Resuming `extension_login` with a `deviceCode` while authorization is
  still pending no longer claims a userCode of "(see the previous
  response)". Only a hash of the code is stored, so it cannot be echoed
  again; the result now says plainly that the one-click link and code
  from the previous response are still valid, to open that link (or
  enter the code at the verification URI), then call `extension_login`
  again with the same deviceCode.

## 5.3.0

The DevX surprise swarm ran ten personas over the full create-to-release
journey and ranked five blocker clusters. All five land here.

### Added

- `extension_release_list`: the discovery sibling of the release verbs.
  Lists the project's channels (channel to promoted build sha) and recent
  builds from the public registry (registry.extension.land), so a caller
  can pick a valid `buildSha` for `extension_release_promote`,
  `extension_deploy`, or `extension_publish` instead of hunting the
  console. Read-only, needs no auth for public projects. Tool count is
  now 32.
- A shared public-registry client (`src/lib/registry.ts`) that reads
  meta, channels, the build index, and store credential health. Reads
  are best-effort: a registry blip never fails the verb it decorates.

### Fixed

- `extension_create` announces every decision it took without being
  asked. The resolved destination path leads the result, and
  `defaultsApplied` names each silent choice (server cwd, package
  manager, browser, git init) as one. Validation errors now teach the
  full argument schema, required, optional, and aliases, instead of
  revealing one missing field per attempt.
- `extension_dev` no longer forks sessions. A second call on the same
  projectPath used to return ok:true while its browser died on the
  profile lock; it now detects the live session and refuses, or stops it
  first with `replace:true` and says so. A dead browser leg no longer
  rides an ok:true envelope: the ready contract's `browser_exited` stamp
  and the profile-lock signature both surface as failures.
- `extension_stop` finds orphaned sessions. It unions the in-memory
  registry with the on-disk session markers, so a session whose dev
  child exited (exactly when the orphaned browser most needs stopping)
  is still found, verified, and reaped. A stale marker yields an honest
  stopped:false and is pruned, never a phantom kill.
- `extension_deploy` dry runs stopped echoing an unqualified
  "Preflight OK". The preflight now reads per-store credential health
  from the registry and reports each browser as actionable, not
  configured, or unverifiable, with the console stores URL in the
  result. The silently defaulted channel is disclosed and checked
  against channels.json. Under dryRun a platform error now reads
  "preflight failed", never "submit failed".
- `extension_release_promote` dead-ends carry the way out: a 404 or
  UNKNOWN_BUILD error now includes each channel's currently promoted
  sha, the registry URL it read, and the console Builds page URL, plus
  a pointer to `extension_release_list`.
- `extension_publish` says what the share link serves: the build sha,
  build time, version, and channel behind the URL, resolved from the
  registry's build index, with a note when it is the newest successful
  build rather than a pinned one.

## 5.2.0

### Added

- `extension_manifest_validate` warns when a Chrome-desktop-only manifest
  key (for example `file_browser_handlers`) rides an Edge target, where it
  is inert. Family-level prefix resolution already worked; this adds
  granularity inside the chromium family for Edge-targeted publishers.
- `extension_logout` now returns `revokeUrl` pointing at the project's
  access-tokens page and says plainly that the token stays valid
  server-side until revoked there. The scope is read before the local
  credentials are cleared so the link can still be built.

## 5.1.2

### Fixed

- `extension_logs` no longer flags a healthy live session as stale. Newer
  engine canaries stamp log and event rows with ready.json's `instanceId`
  rather than its `runId`, so the staleness check compared ids from two
  different spaces and every live read carried `stale: true` with a
  do-not-trust warning. The comparator now accepts either identity field,
  pinned by a test against the real contract shapes. (Filed upstream as
  Extension.js bug 77 so the ready/logs contract agrees on one field.)

## 5.1.1

### Added

- `extension_deploy` warns when a Firefox or Edge submission ships without
  the STORE.md notes the platform submits automatically (Firefox reviewer
  and release notes, Edge certification notes). The warnings ride along in
  the result as `warnings` and never block the submission; Chrome-only
  submissions stay silent.

## 5.1.0

The engine closed its entire open bug range (Extension.js 61-73) in the
4.0.14 canary line. This release re-aligns the MCP with the fixed engine,
finishes the MCP-side half of those bugs, and continues the
report-failure-not-false-success program that 5.0.0 started. 5.0.0 was never
published to npm; installing 5.1.0 picks up both.

### Fixed

- **Sessions now genuinely survive the MCP process.** `detached: true` alone
  never did it: the child held pipes to the MCP, so when the MCP exited the
  next compile log line killed the dev server with EPIPE. Launch tools
  (`extension_dev`/`start`/`preview`) now stream the child's output to a
  session log file (returned as `logPath`) instead of pipes. A detached
  session outlives the MCP and a fresh MCP process rediscovers it through
  `ready.json` and can stop it. Pinned by a detach-contract test.
- **`extension_preview` no longer reports `launched` for a process that died
  in seconds.** It health-checks the child like `dev`/`start` (the MCP half of
  engine bug 72), and all three launch tools read the engine's new
  `browser_exited` stamp, so a browser that dies after launch (for example a
  rejected add-on) returns `status:"browser-exited"` instead of success.
- **`extension_doctor` names a dead browser.** A `browser_exited` ready
  contract now produces a runtime-errors failure that says the browser died,
  with the matching remedy, instead of the generic "fix the build error"
  wording that pointed at a build that was fine.
- **`extension_create` verifies the scaffold.** A resolved create over a
  partial tree (an interrupted template download) returned `nextSteps`
  pointing at a project that could not compile. It now checks the manifest
  exists and returns `status:"incomplete"` when it does not.
- **`extension_manifest_validate` is per-target honest.** `chromium:`/
  `firefox:` prefixed keys resolve per target, `edge` joins the default
  matrix, `manifest_version` must be 2 or 3, a `default_locale` without its
  `_locales` catalog blocks, and a missing 128px store icon warns
  (`extension_inspect` reports `has128Icon`).
- **Stale state stops being served as live.** `extension_logs` stamps
  `stale:true` when the producing session is dead or from a different run;
  `extension_wait` returns `runtimeErrors` alongside ready instead of a bare
  green over a crashing worker; `extension_build` reports
  `productionDivergence` when the production manifest lost permissions or
  resources relative to source.
- **`extension_open`'s `asTab` fallback fires on the user-gesture wall**, and
  `extension_storage` set without a `key` answers in MCP vocabulary rather
  than CLI flags.

### Added

- **Structured bundler warnings on `extension_build`.** The engine now
  persists its build summary to `dist/extension-js/<browser>/
  build-summary.json` (the transport half of engine bug 73), and the tool
  returns it as `buildWarnings` (with `buildWarningsTruncated` naming the
  true count when the engine capped the list). Older engines simply omit the
  field; nothing is scraped from stdout.
- **Popup-faithful headless rendering.** A popup rendered as a tab is now
  sized like the real popup: the document's content size is measured over
  CDP, clamped to Chrome's 25x25-800x600 popup bounds, and the window is
  resized to it (reported as `renderedAsTab.popupBounds`). If the browser
  does not verifiably honor the resize, the tool keeps saying "no popup
  sizing" instead of implying fidelity. Note headless-new is one such
  browser: it accepts `Browser.setWindowBounds` and changes nothing, so
  headless sessions get the honest fallback, not a resized window. The
  measurement also leaves `body`'s authored width alone; only the root takes
  the temporary fit-content override, so a popup that sizes itself through
  `body { width }` measures at its real width.
- **CI typechecks the tests.** `pnpm typecheck` covers `src/` and the test
  tsconfig, wired into the CI matrix, so type drift between tools and their
  tests cannot accumulate silently again.

### Changed

- **Tool prose caught up with the fixed engine.** `extension_eval` and
  `extension_dom_inspect` now advertise the surface contexts
  (`popup`/`options`/`sidebar`/`devtools`) and override pages
  (`newtab`/`history`/`bookmarks`) the engine's relay serves, needing no tab
  id. The "content eval is known-broken" guard is version-honest: on
  Extension.js >= 4.0.14 a null is the expression's real result, and the note
  says so instead of condemning a repaired path. Firefox hints name every
  working route.

A pass focused on a single question: when something has gone wrong, does the
tool say so? Five tools were reporting success over a failure. All five now
verify before they claim anything.

### Breaking

- **`extension_build` refuses a broken build.** It runs the
  `extension_manifest_validate` checks as a preflight and returns
  `status:"blocked"` on build-blocking errors instead of shelling out to a build
  it knows is broken. Pass `skipValidation: true` for the old behavior. It also
  returns `success:false` with `status:"incomplete"` when the bundler exits 0 but
  a declared entrypoint never reached `dist/`, because the browser refuses to
  load that artifact. Non-blocking findings ride along as `manifestWarnings`.
- **Browser resolution defaults to `chrome`, not `chromium`.** A dead session
  used to fall through to a blind default, so every call after a dev server
  exited silently retargeted a browser the caller never ran. A dead session now
  resolves to its own browser with `source:"stale"`.
- **`extension_open` renames `tab` to `target`.** The value is a CDP target id,
  not a `chrome.tabs` id, and the old name invited callers to pass it straight
  into tools that need a numeric tab id.

### Fixed

- **`extension_doctor` no longer reports `healthy:true` over a crashing
  extension.** Its runtime-error check read the wrong field, so every error row
  in `logs.ndjson` collapsed to an empty string and was skipped. It now reads the
  engine's `messageParts` payload, with an `errorName`/`stack` fallback, and
  collapses a throw that repeats on every event.
- **`extension_dev` and `extension_start` no longer report `status:"started"`
  for a server that already exited.** Both health-check the child process and
  return `status:"exited"` with the exit code, signal, and the child's own output
  as evidence.
- **`extension_open` no longer reports success for a navigation that failed.**
  Navigating to a `chrome-extension://` origin is cross process and swaps the
  render frame, so the pre-navigation session reported a stale error URL on
  success and success on failure. It now confirms against a fresh target list.
  This affected the `url` navigation path shipped in 4.9.0, not only the new
  surface rendering.
- **`extension_open` targets the right extension.** A dev session also loads
  Extension.js's own manager extension, and taking the first extension target
  navigated against the wrong origin. The id is now derived from the dist path
  the session actually loaded.

### Added

- **Headless surface rendering.** `extension_open` accepts `asTab` for
  `popup`/`options`/`sidebar`, rendering the surface document in a real tab so it
  can be inspected where no window exists to host a popup. It is applied
  automatically when a headless session refuses to open the surface, with a note
  saying what was substituted.
- **Tab targeting by url.** `extension_eval` and `extension_dom_inspect` take a
  `url` and otherwise default to the active tab, and `extension_dom_inspect`
  gains `listTabs` for discovery. The engine gained this in 4.0.13; the tool
  descriptions had been telling callers a numeric tab id was required.
- **Friendlier arguments.** `timeoutMs`, `lines`, `tabId`, `href` and
  `browserName` fold onto their canonical names, `withConsole` accepts `true`,
  and the input validator understands union types.
- **`extension_create` matches your package manager.** Hints and the engine
  warning now use bun, pnpm or yarn when that is what the scaffold used, and the
  warning reads the pin the scaffold actually wrote.

## 4.9.0

A second pass from the persona swarm, closing the gaps 4.8.0 left and the top
new blockers it surfaced.

- **Honest `extension_manifest_validate`.** It now scans the project source for
  permission-gated `chrome.*`/`browser.*` calls and flags any the manifest does
  not declare, an API used without its permission is `undefined` at runtime and
  crashes the context, the exact case where validate used to report `valid:true`.
  The headline is now honest (`valid:false` + `buildBlocking:true` on any error),
  and it accepts singular `browser` as an alias for `browsers`.
- **`extension_open` can navigate a tab.** Pass a `url` (Chromium, via CDP) to
  drive a content-script test page, a `webNavigation` target, or the popup as a
  page (`chrome-extension://<id>/popup.html`), the loop the surface-only open
  could not do. `target` is accepted as an alias for `surface`.
- **`extension_stop` actually reaps the session.** It now terminates the dev CLI
  and both browser families (gecko profile + chromium `--load-extension`, under
  the project's dist) and refuses to report `stopped:true` while any survive.
- **`extension_wait` won't lie about a dead session.** A `ready.json` whose pid
  is dead now returns `status:"stale"` instead of `ready`, so you don't walk into
  a reload/eval that fails with a misleading control-channel error.
- **Dropped-channel errors name the real cause.** A `1006` / "no control channel"
  now detects an exited dev server (stale ready.json + dead pid) and says so,
  instead of asking "is the session started with allowControl?" when it was.
- **`extension_doctor`** surfaces recent error-level logs as a `runtime-errors`
  check (so a background throwing on every event isn't `healthy:true`), keeps the
  project-local engine version in project mode, and flags when that engine
  differs from a pinned `EXTENSION_MCP_CLI_VERSION`.
- **`extension_build`** lists declared entrypoints in its success output, so a
  content script no longer reads as "didn't build".
- **`extension_create`** forces non-interactive git (`GIT_TERMINAL_PROMPT=0`) so a
  credential prompt can't hang the template download, retries once on a transient
  network/timeout failure (cleaning the partial dir first), reports a download
  failure as such instead of "choose a valid template name", and warns when the
  scaffold's `extension@latest` pin will win over your pinned CLI.
- Eval/inspect error guidance now speaks MCP JSON args (`context`, `tab`, `url`)
  instead of CLI flags.

## 4.8.0

Dev-session ergonomics hardened from a 30-persona agent walk of the toolchain.

- **`allowEval` now implies `allowControl`.** Enabling eval on `extension_dev`
  also opens the control channel, so a single `allowEval: true` unlocks
  `extension_storage`/`reload`/`open`/`dom_inspect` too. `extension_dev` now
  returns a `capabilities` block naming exactly which verbs the session unlocked,
  ending the stop-and-restart loop that hit agents who passed one flag and not
  the other.
- **Session-aware browser default.** `extension_stop` (and the other
  browser-scoped tools) resolve the browser from the one live session for the
  project instead of assuming `chrome`. `extension_stop` also reaps the launched
  browser's process tree and refuses to report `stopped: true` while a process
  survives, fixing orphaned browsers (notably Firefox) after a stop.
- **Forgiving argument names.** Common synonyms are accepted and normalized:
  `path`/`dir` for `projectPath`, `name` for `projectName`, `template` for
  `slug`, `code` for `expression`, and more, so a reasonable first guess no
  longer 400s.
- **`extension_manifest_validate`** accepts `projectPath` (it finds the
  manifest) and probes path-valued fields (popup, service worker, icons, content
  scripts) against disk, warning on dangling references instead of a false
  all-clear.
- **`extension_doctor`** inlines the dev session's own recorded errors so a build
  or load failure no longer reads as healthy.
- **`extension_inspect`** lists declared entrypoints (so a small content script
  is not buried under assets) and warns when a store-listing promo image is
  shipped inside the package.
- **`extension_source_inspect`** on a Gecko session now names the working
  alternatives (`extension_logs`, `extension_eval`) instead of pointing back at
  the tool that just refused.

## 4.7.0

`extension_deploy` now submits **through** extension.dev instead of driving a
local CLI. Pass `browsers` + `buildSha` and the submission is routed to the
platform, which holds your store credentials and dispatches the release from
your project's mirror CI; authentication is your `extension_login` session or a
release token in `EXTENSION_DEV_TOKEN`, and it defaults to a dry run. The tool
is now a thin authenticated client of the platform's store-submission endpoint,
exactly like `extension_publish` and `extension_release_promote`, with no
external CLI dependency. This replaces the previous mode that shelled out to a
standalone local CLI. Direct zip-based submission with store credentials in the
environment is no longer exposed through the MCP; use your own CI pipeline for
that.

## 4.6.0

New `extension_deploy` tool (31 tools total): submit a built extension to the
Chrome Web Store, Firefox AMO, and Edge Add-ons by driving a standalone
deploy CLI. Store targets are inferred from the `.zip` paths
you pass. It defaults to a dry run, and store credentials are read from the
environment or a `.env.submit` file, never from tool arguments, so secrets
never enter the agent transcript.

## 4.5.0

The platform client (GitHub device-code login, the credential store, and the
publish flow) is now vendored directly in this package instead of the
separate `@extension.dev/core` dependency. No behavior change: the tool
schemas, the credential file, token resolution, and the publish error
envelopes are all unchanged. This drops a runtime dependency and the
two-package release step.

## 4.4.0

Browser-matrix parity release: the tool surface now mirrors the engine
CLI flag for flag, and a 30th tool cleans up the managed browser cache.

- New tool `extension_uninstall_browser`. Removes a managed browser
  binary from the Extension.js cache (or every one with `all: true`).
  Only touches the managed cache, never system-installed browsers.
- Full Extension.js browser matrix in `extension_detect_browsers`: all
  eleven supported browsers (chrome, chromium, edge, brave, opera,
  vivaldi, yandex, firefox, waterfox, librewolf, safari) are probed,
  each reported with its engine family and whether the managed
  installer can provision it.
- Shared browser-launch flags on `extension_dev`, `extension_start`,
  and `extension_preview`: `profile` (path, or `"false"` to reuse the
  default user profile), `startingUrl`, `chromiumBinary` /
  `geckoBinary` custom binaries, `host` / `publicHost` for Docker and
  devcontainer splits, and companion `extensions` loaded alongside the
  project.
- `extension_build` closes its gaps against the engine CLI:
  `zipFilename`, `polyfill`, `silent`, and `mode`
  (development/production/none, also sets NODE_ENV).
- Engine dependencies bumped to ^4.0.11.
- The shipped debugging docs are rewritten around the live inspect
  surface.
- Release plumbing: npm publishes now carry provenance from a
  changelog-backed GitHub workflow, the npm README renders the logo at
  the right width via pack hooks, and the Safari web extension keyword
  aids npm discovery.

## 4.3.0

Diagnosis + version-skew release: a 29th tool that turns "an act tool
errored, now what" into one call, and a CI that tests the engine
versions users actually run.

- New tool `extension_doctor`. Wraps `extension doctor --output json`:
  walks the dev session's control-channel legs (ready contract,
  dev-server process, control-port agreement, control channel, eval
  token, executor, browser liveness) and returns one
  `{check, status, detail, remediation?}` entry per leg in dependency
  order. Detail and remediation prose are rewritten to MCP-speak like
  every other act-verb error. Engines that predate the `doctor` verb get
  a clean CliError with a hint instead of a crash.
- Browser-family classification now has ONE copy
  (`src/lib/browser-family.ts`). Fixes real drift: `browsers:
  ["chromium"]` ran ZERO family checks in `extension_manifest_validate`
  (an MV2 manifest validated "fine"), and `chromium` was still missing
  from the `extension_build` / `extension_dev` / `extension_preview` /
  `extension_start` schema enums.
- CI version-skew matrix: every push builds and tests against the
  engine canary, the latest stable, and the vendored floor (deduped),
  plus a nightly run that exercises the real `npx extension@<pin>` path
  end-to-end (`RUN_CLI_SMOKE=1`). A red canary cell now surfaces engine
  regressions the day they publish instead of on the next unrelated PR.
- Legacy ready-contract compatibility suite: fixtures pin the contract
  shapes older engines wrote (no `cdpPort`, no `pid`), so a 4.0.6-era
  session stays visible to browser defaulting and `resolveCdpPort`
  refuses to adopt an unrelated developer Chrome instead of probing a
  bogus port.

## 4.2.2

Agent-ergonomics release from the 4.2.1 fresh-eyes walk: the two changes
that removed nearly all friction a real MCP client hit.

- Session-aware browser default. Tools that target a running session
  (`extension_logs`, `extension_reload`, `extension_eval`,
  `extension_storage`, `extension_open`, `extension_dom_inspect`,
  `extension_list_extensions`, `extension_source_inspect`,
  `extension_wait`) no longer hard-default `browser` to a constant that
  could disagree with the session `extension_dev` actually started.
  Omitting `browser` now resolves to the active session's browser:
  in-memory registry first, then the freshest live `ready.json` contract
  on disk (dead pids ignored), then the old constant. Starting a session
  with `browser: "chrome"` and calling `extension_logs` with no args now
  just works instead of erroring about a missing chromium channel.
- Error hints speak the MCP tool surface, not the CLI. Act-verb error
  prose is rewritten before returning: `` `extension dev
  --browser=chromium --allow-control` `` becomes `extension_dev with
  { browser: "chromium", allowControl: true }`, and stray
  `--allow-control` / `--allow-eval` / `--browser=<x>` mentions become
  their tool-argument names. Result data is never touched, only
  error/hint prose. Tool descriptions now name `allowControl` /
  `allowEval` directly, so agents no longer discover the gates by
  fuzzing the schema.
- The no-channel error now names the session that IS running ("Active
  session browser(s) for this project: chrome, pass that as `browser`"),
  so an agent retargets instead of spawning a second, conflicting
  session. Same for the `extension_logs` follow miss.
- `extension_list_extensions` / `extension_source_inspect` accept
  `browser: "chromium"` (the default dev target) instead of rejecting it
  as non-Chromium.
- Tests: session-browser resolution + hint-translation suite (137 total).

## 4.2.1

`extension_build` failures no longer kill the MCP server process
(fatal-error path returned a rejected promise the server didn't catch).
CDP-dependent tools resolve the debug port from the session's ready
contract instead of assuming 9222 (plus a test-only engine pin
override, `EXTENSION_MCP_CLI_VERSION`).

## 4.2.0

Session lifecycle + determinism release. Tool count 27 -> 28.

- New tool `extension_stop`: terminates a dev/start/preview session (dev
  server AND the browser it launched) via a process-group signal with
  SIGTERM -> SIGKILL escalation. Finds the pid in the in-memory session
  registry, falling back to the `ready.json` contract when the MCP server
  restarted since the session began, and removes the stale contract so
  `extension_wait` cannot report a dead session as ready. Supports
  `all: true` to stop everything the server started.
- Sessions self-clean: dev/start/preview register an exit listener so a
  session that dies on its own is no longer reported as stoppable.
  `extension_preview` sessions are now registered (and stoppable) too.
- `extension_create` gains `parentDir`: control where the project lands
  instead of inheriting the MCP server's working directory. `nextSteps`
  now reports the full project path.
- CLI spawns are deterministic: dev/start/preview and the act tools now
  prefer the project's own `node_modules/.bin/extension`, falling back to
  `npx extension@<pinned>` where the pin derives from the vendored
  `extension-develop` version, never a floating `latest`.
- Session registry keys are path-normalized, so a stop with an absolute
  path matches a session registered with a relative one.
- Tests: registry suite now asserts against the exported `tools` array
  (the old hand-maintained mirror had drifted to 26 while the server
  registered 27); new stop + CLI-resolution suites (123 tests total).

## 4.1.2

README: restore the `@extension.dev/skill` pairing section (hands +
judgment) now that the skill is public on npm. No code changes.

## 4.1.1

README rewritten for the public npm page: Extension.js-style header
(badges, tagline, quick start), tool table updated to the full 27-tool
surface (release-promote was missing), and links to private repos or
npm-restricted packages removed. Package description tool count fixed
(26 -> 27). No code changes.

## 4.1.0

The MCP now consumes `@extension.dev/core` for all platform-auth logic
(core MIGRATION.md phase 2). No tool schema changes, no behavior changes:
the JSON-string envelopes are byte-compatible and pinned by tests.

- New dependency `@extension.dev/core` ^0.2.0: device-code login, credential
  store, and publish client now live there, shared with every other surface.
- Deleted `src/lib/credentials.ts`, `src/lib/github-device.ts`,
  `src/lib/login-flow.ts` and their migrated tests; `login`, `whoami`,
  `logout`, and `release-promote` import from core.
- `tools/publish.ts` is a thin adapter over core's `publish()`; the frozen
  PublishAuthError / PublishConfigError / PublishNetworkError / PublishError
  envelopes and the success passthrough are pinned by a new
  `publish-envelope` test.
- New `core-boundary` regression test: no file under `src/` may redefine the
  credential store or import auth primitives from anywhere but
  `@extension.dev/core`.
- CI and Release workflows pass `NPM_TOKEN` to the install step (core is
  npm-restricted until the public flip).

## 4.0.8

Tracks the `extension` 4.0.8 suite (the versioning convention: this package's
version follows the CLI suite release it pairs with). One tool was added since
3.17.0, `extension_release_promote`, bringing the surface to 27 tools.

- Bump `extension-create`, `extension-develop`, `extension-install` from
  ^3.13.5 to ^4.0.8. All consumed APIs (`extensionCreate`, `extensionBuild`,
  `extensionInstall`, `getManagedBrowsersCacheRoot`) and all CLI verbs the
  tools shell out to (`dev`, `start`, `preview`, `logs`, `eval`, `storage`,
  `reload`, `open`, `inspect`, `publish`, including `--allow-control`,
  `--allow-eval` and `--no-browser`) are unchanged in 4.x; verified
  end-to-end (create -> build -> dev ready contract -> manifest validate).
- `package.json` version now matches the published line (was a stale 0.0.1)
  and the server reports its version from `package.json` instead of a
  hardcoded string (previously stuck at 3.13.5).
- `browser-extension-manifest-fields` ^2.2.8 -> ^2.2.9.
- vitest config: resolve the extension-* test aliases from the packages'
  exports maps; 4.x dropped the CJS entry, so `require.resolve` on the bare
  specifier no longer works.

## 3.17.0

First stable release on npm. The registry previously carried only canary
builds (3.17.0-canary.*), so `npx @extension.dev/mcp` resolved a canary;
this release graduates that line to stable and becomes `latest`.

- 26 tools across scaffolding, build/dev/preview, live inspection (CDP +
  agent bridge), act tools (eval/storage/reload/open), browser management,
  and platform auth/publish.
- Claude Code integration assets (CLAUDE.md, slash commands, rules) and the
  @extension.dev/skill pairing.
- MIT license shipped; repository moved to extensiondev/mcp.

# @extension.dev/mcp, Changelog

## 5.5.1, agent-bridge tools

Adds the MCP client surface for the Extension.js **agent bridge** (dev-time
observe + act + inspect). All new tools shell out to the `extension` CLI verbs
(lockstep invariant: the CLI is the single source of behavior), so they require
a recent **`extension` CLI that ships the bridge verbs** (`logs`, `eval`,
`storage`, `reload`, `open`, `inspect`, `publish`).

> ⚠️ **Release order:** publish this package ONLY after the `extension` /
> `extension-develop` suite that ships those verbs is on npm. The published CLI
> at the time of writing (`3.17.0`) does NOT have them, publishing this package
> before the suite would ship tools that fail with "unknown command". Bump the
> version + `extension-*` deps to that suite release, then publish.

New tools (22 total):

- **`extension_logs`**, read/stream logs from every extension context
  (background, content, popup/options/sidebar/devtools); filters
  `level`/`context`/`url`/`tab`/`since`, bounded `follow` window.
- **`extension_eval`**, evaluate an expression in a context (requires the dev
  session started with `--allow-eval`; MV3 service worker is CSP-gated).
- **`extension_storage`**, read/write `chrome.storage` (requires `--allow-control`).
- **`extension_reload`**, reload the extension or a tab (`--allow-control`).
- **`extension_open`**, open popup/options/sidebar (`--allow-control`).
- **`extension_dom_inspect`**, CDP-free DOM snapshot of content/page or an open
  surface (popup/options/sidebar/devtools); `withConsole` merges recent logs.
- **`extension_publish`**, publish to extension.dev and return a shareable URL
  (auth-gated; requires `EXTENSION_DEV_TOKEN`).
- **`extension_source_inspect`** gains **`deepDom`**, pierce CLOSED shadow roots
  via CDP (Chromium only).

Internal: `lib/act` (CLI shell-out helper), `lib/exec.runExtensionCli` (capture),
`lib/cdp.getClosedShadowRoots`. Test infra aligned to the workspace vitest
catalog.

## 5.5.1, login (auth tools)

Adds the missing `login` flow so `extension_publish` no longer requires the user
to mint and export `EXTENSION_DEV_TOKEN` by hand. Auth stays auth-AWARE: the
token lives in a local credentials file, never in the MCP process state or logs.

New tools (25 total):

- **`extension_login`**, GitHub **device-code** flow (no local server; works
  headless). Two-phase: call with `project` (`<workspace>/<project>`) to get a
  code + URL, call again with the returned `deviceCode` to finish. On success it
  writes a project-scoped token to the credentials file. Never returns the token.
- **`extension_whoami`**, report the stored workspace/project and token expiry
  without revealing the token.
- **`extension_logout`**, delete the local credentials file.

Token resolution for publish is now `EXTENSION_DEV_TOKEN` env **>** the
credentials file (expired file tokens are ignored).

Credentials file (versioned, `0600`): `$XDG_CONFIG_HOME/extension-dev/auth.json`
(or `~/.config/...`; `%APPDATA%\extension-dev\auth.json` on Windows).

Platform endpoints this depends on (in `apps/www.extension.dev`):

- `GET /api/cli/login/config`, public GitHub OAuth client id + scope.
- `POST /api/cli/login/exchange`, trades a GitHub **user** token for a
  project-scoped access token after checking workspace membership. Modeled on
  `/api/oidc/exchange`; tokens are recorded so they stay revocable.

> ⚠️ **Ops:** the device flow requires **device flow enabled** on the GitHub
> OAuth App behind `WWW_GITHUB_OAUTH_CLIENT_ID`. Until then, `extension_login`
> can't complete and users fall back to a dashboard-minted `EXTENSION_DEV_TOKEN`.
